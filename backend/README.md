# Crop Analytics API

FastAPI + PostgreSQL/PostGIS. Serves plot boundaries and crop-condition layers
to any client.

See the [main README](../README.md) to get it running. This file is the API
reference and the notes a developer needs to change it.

---

## Design decisions worth knowing

**Plain SQL, not an ORM.** Nearly every query here is spatial —
`ST_Intersection`, `ST_Transform`, `ST_AsGeoJSON`. Those read far more clearly as
SQL than as ORM expressions, and PostGIS is the point of the design rather than a
detail to hide.

**PostGIS does all the geometry.** Reprojection, repair, intersection and area
are database operations, so the Python side needs no GDAL, GEOS or geopandas.
That keeps the Docker image small and the install trouble-free.

**Files are streamed, never loaded whole.** Uploads go to disk in 1 MB chunks and
are parsed with `ijson`, which yields one feature at a time. A 72 MB GeoJSON
would take roughly 1.5 GB of RAM if parsed with `json.load`.

**Analysis is clipped at upload time, not per request.** This is the single most
important decision in the codebase — see
[the main README](../README.md#the-analysis-layer--status-7th-aug-2026geojson)
for why.

---

## Endpoints

Base URL locally: `http://localhost:8010`. Interactive docs at `/docs`.

All routes except `/health` and `/api/auth/*` need `Authorization: Bearer <token>`.

### Auth

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/request-otp` | Send a code to a phone number |
| `POST` | `/api/auth/verify-otp` | Exchange a code for a token |

```jsonc
// POST /api/auth/request-otp   {"phone": "9876543210"}
{
  "phone": "+919876543210",
  "message": "A 6-digit code has been sent to +919876543210.",
  "dev_otp": "482913"   // only when SMS_PROVIDER=console; null otherwise
}

// POST /api/auth/verify-otp    {"phone": "9876543210", "code": "482913"}
{
  "token": "eyJhbGciOi...",
  "role": "farmer",
  "farmer": { "id": 28142, "farm_code": "M01999", "plot_count": 65, ... }
}
```

Phone numbers are normalised to E.164. A bare 10-digit number is assumed Indian
and gets `+91`.

### Farmer

Every one of these is scoped to the `farmer_id` in the token.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/me` | Profile and totals |
| `GET` | `/api/me/plots` | The caller's plots, no geometry |
| `GET` | `/api/plots/{id}` | One plot with boundary GeoJSON and bbox |
| `GET` | `/api/plots/{id}/layers` | Layers that have data for this plot |
| `GET` | `/api/plots/{id}/analysis/{layer_id}` | Clipped analysis + breakdown |

`/api/plots/{id}/analysis/{layer_id}` is what the map draws:

```jsonc
{
  "layer": { "id": 1, "name": "Crop Status", "capture_date": "2026-08-07",
             "classes": [ { "class_id": 1, "label": "Category 1",
                            "detail": "0.00 – 0.08", "color": "#ffce60",
                            "class_name": "Density slice range 0.0000 to 0.0837" } ] },
  "plot_id": 28206,
  "covered_area_ha": 0.1377,
  "breakdown": [
    { "class_id": 4, "label": "Category 4", "detail": "0.25 – 0.33",
      "color": "#e23b6e", "area_ha": 0.0697, "percent": 50.64 }
  ],
  "geojson": { "type": "FeatureCollection", "features": [ /* ... */ ] }
}
```

Each feature carries its own `color`, so the map styles straight from the data
and can never disagree with the legend.

### Admin

All require the admin role.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/admin/units` | Units, with plot and layer counts |
| `PUT` | `/api/admin/units/{id}` | Rename a unit |
| `POST` | `/api/admin/plots/import` | Import a unit's plot register (runs inline) |
| `POST` | `/api/admin/layers` | Upload an analysis layer (runs in background) |
| `GET` | `/api/admin/layers?unit_id=` | List layers, optionally for one unit |
| `GET` | `/api/admin/layers/{id}` | One layer — poll this to watch processing |
| `PATCH` | `/api/admin/layers/{id}` | Rename, re-describe, publish/unpublish |
| `DELETE` | `/api/admin/layers/{id}` | Delete a layer and everything derived |
| `GET` | `/api/admin/layers/{id}/classes` | The layer's legend |
| `PUT` | `/api/admin/layers/{id}/classes` | Rename and recolour categories |
| `GET` | `/api/admin/farmers?search=` | Search farmers |
| `PUT` | `/api/admin/farmers/{id}/phone` | Set a farmer's login number |
| `GET` | `/api/admin/stats` | Dashboard counts |

Both upload endpoints require a `unit_id` form field and accept an optional
`srid` to override the CRS declared in the file.

### Editing categories

```jsonc
// PUT /api/admin/layers/1/classes
{ "classes": [ { "class_id": 4, "label": "Needs attention", "color": "#ff0000" } ] }
```

Because the API sends each polygon its own colour, this reaches the farmer's map
*and* legend on their next request — the layer is not reprocessed and the app is
not rebuilt. Colours must be `#rrggbb`; unknown class ids and blank names are
rejected rather than silently ignored.

---

## Configuration

All settings come from the environment, or `backend/.env`. See `.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | localhost:5433 | Points at the compose database |
| `JWT_SECRET` | `dev-secret-change-me` | **Must be changed in production** |
| `JWT_EXPIRY_HOURS` | `720` | 30 days, so farmers rarely re-authenticate |
| `ADMIN_PHONES` | — | Comma-separated. These numbers get the admin role. |
| `SMS_PROVIDER` | `console` | `console` returns the OTP in the response |
| `OTP_LENGTH` | `6` | |
| `OTP_TTL_SECONDS` | `300` | |
| `OTP_MAX_ATTEMPTS` | `5` | Wrong guesses before a new code is required |
| `UPLOAD_DIR` | `./var/uploads` | Where uploaded GeoJSON is kept |
| `CORS_ORIGINS` | localhost:5174 | Comma-separated |

Admins are configured by phone number rather than stored in a table, so there is
no chicken-and-egg problem creating the first one.

---

## Database

Migrations are numbered `.sql` files in `migrations/`, applied automatically at
startup. A `schema_migrations` table records what has run, so startup is
idempotent.

To add one, create `migrations/002_something.sql` and restart the API.

Open a psql shell:

```bash
docker exec -it crop-pulse-db psql -U croppulse -d croppulse
```

Useful checks:

```sql
-- How much of each plot has analysis?
SELECT count(*) FILTER (WHERE analysed > 0) AS plots_with_analysis,
       round(avg(analysed / NULLIF(area, 0))::numeric * 100, 1) AS pct_covered
FROM (
  SELECT ST_Area(p.geom::geography) / 10000.0 AS area,
         COALESCE(sum(pa.area_ha), 0)         AS analysed
  FROM plots p
  LEFT JOIN plot_analysis pa ON pa.plot_id = p.id AND pa.layer_id = 1
  GROUP BY p.id, p.geom
) c;

-- The legend for a layer
SELECT class_id, label, color, class_name
FROM analysis_classes WHERE layer_id = 1 ORDER BY sort_order;
```

---

## Working on the code

The container runs the API, so the normal loop is:

```bash
docker compose up -d --build api
docker compose logs -f api
```

If you would rather run it on your machine for auto-reload:

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8010
```

Keep the database in Docker either way (`docker compose up -d db`); the default
`DATABASE_URL` already points at it.

> On macOS, Homebrew's Python can fail to create a virtualenv with a `pyexpat` /
> `libexpat` symbol error. That is a Homebrew/macOS mismatch, not a project
> problem — run the API in Docker, or `brew reinstall python@3.12`.

### Where to change things

| To change... | Edit |
|---|---|
| Legend colours or labels | `app/palette.py` |
| Which property holds a phone number | `PHONE_KEYS` in `app/ingest.py` |
| Which plot fields are promoted to columns | `app/ingest.py` + a migration |
| Add a real SMS gateway | `app/sms.py` — one class, then set `SMS_PROVIDER` |
| Token lifetime, OTP rules | `.env` |

### Performance notes

Both tunables live at the top of `app/ingest.py`:

- `BATCH_SIZE` (1,000) — features per database round trip.
- `CLIP_CHUNK` (2,000) — plots clipped per statement. Smaller means shorter
  transactions and more frequent progress logs.

With the sample data on an M-series Mac: plot import ~5 s, analysis load and clip
a few minutes. Serving one plot's analysis is ~5 ms.

If clipping ever becomes too slow, the first thing to try is raising
`CLIP_CHUNK` and giving PostgreSQL more `work_mem` — the intersection is
dominated by `ST_Union` over the pieces of each plot.
