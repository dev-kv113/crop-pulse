# Crop Analytics

A mobile and web app that shows sugarcane farmers their own plots on satellite
imagery, with switchable survey layers that colour each plot by crop condition.

Farmers sign in with their mobile number and a one-time code. Admins sign in the
same way and additionally get a screen for uploading data.

```
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│  Web app         │        │                  │        │                  │
│  (browser)       │──────▶ │  Crop Analytics  │──────▶ │   PostgreSQL     │
│                  │  HTTPS │   API            │  SQL   │   + PostGIS      │
│  Phone app       │──────▶ │   (FastAPI)      │        │                  │
│  (same code,     │        │                  │        │                  │
│   installed PWA) │        └──────────────────┘        └──────────────────┘
└──────────────────┘
```

The frontend and backend are separate services in one repository. The API has no
idea the web app exists — any future client (a different app, a dashboard, a
partner system) can use the same endpoints.

---

## Contents

- [What the app does](#what-the-app-does)
- [The data, and what we learned from it](#the-data-and-what-we-learned-from-it)
- [How it fits together](#how-it-fits-together)
- [Run it locally](#run-it-locally)
- [Load the sample data](#load-the-sample-data)
- [Project layout](#project-layout)
- [**How the code works, file by file**](docs/CODEBASE.md)
- [Data format for uploads](docs/DATA-FORMAT.md)
- [What to send us](docs/DATA-SPEC.md) — the same thing written for whoever supplies the files
- [The Android app](#the-android-app)
- [Deploying](#deploying)
- [Before you go live](#before-you-go-live)
- [Troubleshooting](#troubleshooting)

---

## What the app does

**As a farmer**

1. Enter your mobile number, receive a 6-digit code, sign in.
2. Hold one plot and you land **straight on it** — a one-item list is friction
   for nothing. Hold several and you get a short list to choose from, and can
   switch between them from inside the map too.
3. The plot is drawn on satellite imagery, framed to fit, with the most recent
   survey already switched on.
4. Pick a different survey date, switch the basemap between satellite, streets
   and terrain, or turn the boundary outline off.
   If you hold more than one plot, a switcher appears in the panel — it never
   sends you back to a list.
5. The legend shows the full colour scale plus, for each class present, how many
   hectares and what share of your plot it covers.
6. Fade the layer with the opacity slider to check the imagery underneath, or tap
   any coloured patch to read its category, density band and area.

**As a unit head**

1. Sign in with the number an admin registered for your unit.
2. Search every farmer in **your** unit by name, farm code, village or plot ID.
3. Open any of them and see exactly what that farmer sees.
4. Switch to **Crop monitoring** for your unit's dashboard. Its own filters open
   in place, and the button beside the heading opens it in a full tab when you
   want the room. The switch is sticky, so it stays one tap away however far
   down the farmer table you are.

You cannot upload data, change anything, or reach another unit — the unit comes
from your token, so there is no parameter that could point somewhere else.

**As a read-only admin**

1. Sign in with a number a super admin granted the access to.
2. Pick any **unit**. You get exactly the unit head's screen for it: every
   farmer, any farmer's plot as that farmer sees it, and that unit's dashboard.
3. That is all. No uploads, no renames, no publishing, no granting logins.

It is the same screen and the same API routes as a unit head, with the unit
unlocked — so what you see cannot drift from what they see.

**As an admin**

1. Sign in with a number listed in `ADMIN_PHONES`.
2. Pick a **unit**. Everything below is scoped to it.
3. Upload that unit's plot register (boundaries + farmer details).
4. Upload one analysis GeoJSON per survey date. Processing runs in the
   background and the table shows progress.
5. **Name the categories and choose their colours** for any survey date.
6. Show or hide a date from farmers, or delete it outright.
7. In one **Farmers** table: set a farmer's login number inline, and open their
   plot exactly as they see it. Search by farmer, farm code, village or plot ID.
   Results are paged — the table says "50 of 42,096" and loads more on demand.
8. Add **unit heads** to any unit, as many as it needs, or remove one.
9. Rename units from the seeded "Unit 1"… to their real names.
10. Grant or revoke **read-only admin** access for any number.
11. Set each unit's **monitoring dashboard code** — which mill it is in the
    dashboard, e.g. `DEO`. Kept apart from the name so renaming never breaks it.

The admin screen is a two-column grid on a laptop — the two upload forms pair up,
anything with a table spans the full width — and collapses to a single column on
a phone. Setting a phone number lives in the same row as the farmer it belongs
to, so nothing needs scrolling past to reach it.

Adding the 10 August file later is just another upload: it becomes another date
in the farmer's layer list, and the existing dates are untouched. Deleting a date
removes it and everything derived from it.

---

## Units

The mill is organised into units, and data arrives one unit at a time — a plot
register per unit, then an analysis GeoJSON per unit per survey date. That
structure is explicit in the schema, which buys three things:

- A re-upload for one unit cannot disturb another.
- Clipping only considers plots in the **same** unit, so it is both faster and
  correct — a layer never colours in land it does not describe.
- The admin screen scopes uploads, dates and category colours to one unit, so
  there is never doubt about where a file will land.

Eight units are seeded as "Unit 1" … "Unit 8" and can be renamed in the admin
screen. The sample data lives in Unit 1.

---

## The data, and what we learned from it

Two GeoJSON files feed this app. Reading them carefully changed several design
decisions, so they are worth writing down.

### The plot register — `Base Plot layer.geojson`

| | |
|---|---|
| Features | 42,096 plots |
| Geometry | MultiPolygon, one part each |
| CRS | WGS84 (EPSG:4326) |
| Key fields | `FARM_CODE` (14,725 unique farmers), `UNIQ_ID` (unique per plot) |

A farmer holds several plots on average, so `farmers` and `plots` are separate
tables joined by `FARM_CODE`.

**`Survey_Are` is in acres, not hectares.** Across all 42,096 plots it
correlates with the true polygon area at **0.9986** once converted
(1 acre = 0.404686 ha), and the median ratio is 1.001. Labelling it "ha" would
have been wrong on every screen. The app stores both units and shows farmers
acres, which is what they use locally, while the analysis breakdown is in
hectares.

**Two areas, and they are not the same thing.** The app shows both, named:

| Shown as | Where it comes from |
|---|---|
| **Mapped area** | Computed from the boundary coordinates with `ST_Area(geom::geography)`, so it is a real ground area on the ellipsoid |
| **Surveyed area** | `Survey_Are`, what the mill recorded at survey time |

They usually agree closely — for the test plot, 0.3731 vs 0.37 acres. Where they
do not, the difference is worth seeing rather than hiding behind a single
unlabelled number.

> **Preparing the next upload?** [docs/DATA-FORMAT.md](docs/DATA-FORMAT.md) is
> the exact list of property names the importer reads, which are required, and
> the two things that will bite you (`Survey_Are` being acres, and keeping
> `FARM_CODE` stable).

**There is no phone number field.** Farmers cannot sign in until one exists.
The importer looks for `PHONE`, `MOBILE`, `PHONE_NO`, `MOBILE_NO`, `PHONE_NUM`
or `CONTACT` and picks up whichever it finds — so when your next export includes
one, it works with no code change. Until then, set numbers from the admin
screen.

### The analysis layer — `Status 7th Aug 2026.geojson`

| | |
|---|---|
| Features | 179,982 polygons |
| CRS | **EPSG:32643 (UTM zone 43N)** — reprojected on import |
| Properties | `Class_Id`, `Class_Name` only |
| Classes | 8 density slices, spanning 0.0000 → 0.6693 |

Two things about this file drive the whole backend design:

**It is projected, not lat/long.** The file declares EPSG:32643 in a legacy
`crs` member. The importer reads that and reprojects with PostGIS; assuming
WGS84 would have put the data in the Gulf of Guinea. The declared CRS is
detected automatically, and can be overridden per upload.

**It has no plot id.** It is a vectorised raster covering the whole region —
farms, roads and rivers alike. To show a farmer only their own land, the layer
has to be intersected with plot boundaries. Doing that per request would mean a
spatial join across 180k polygons every time someone opens a plot.

So the app does it **once, at upload time**: every analysis polygon is cut to
every plot it touches, and the pieces are stored per plot. Serving a farmer then
becomes a plain indexed lookup. With the sample data this turned 179,982 source
polygons into 140,333 per-plot pieces, and a plot's analysis now comes back in
**about 5 milliseconds as a 3 KB response**. The cost is a few minutes of
processing per upload, paid by an admin, not by a farmer on a phone.

The clipped layer covers **92.5%** of plot area on average — the remainder is
raster edges that do not perfectly tile a boundary — and 42,091 of the 42,096
plots have analysis. The app shows "x ha analysed" so this is never silently
hidden.

### Legend colours

Canopy density is a *sequential* quantity — one number, low to high — so the ramp
runs light to dark without a break. Reading "more" as "darker" needs no legend
lookup. A red-amber-green scale would imply a good/bad midpoint the data does
not have.

The ramp is anchored to the GEOtrans brand: it starts at the wordmark's **amber**
and ends at its **navy**, travelling through orange, coral and magenta so no step
washes out to grey. Lightness falls strictly from OKLCH 0.874 to 0.236, which is
what makes the order readable at a glance. Amber-to-navy also keeps the layer
legible over satellite imagery, where a green ramp would vanish into the fields
it describes.

| | Class | Density band | Colour | | Class | Density band | Colour |
|---|---|---|---|---|---|---|---|
| 1 | Category 1 | 0.00 – 0.08 | `#ffce60` | 5 | Category 5 | 0.33 – 0.42 | `#b02282` |
| 2 | Category 2 | 0.08 – 0.17 | `#ff9a42` | 6 | Category 6 | 0.42 – 0.50 | `#781b85` |
| 3 | Category 3 | 0.17 – 0.25 | `#ff6652` | 7 | Category 7 | 0.50 – 0.59 | `#431872` |
| 4 | Category 4 | 0.25 – 0.33 | `#e23b6e` | 8 | Category 8 | 0.59 – 0.67 | `#16124e` |

Labels are deliberately neutral. The source data gives a density range per class
but no agronomic interpretation, so the app numbers the bands rather than
claiming a range means "good" or "poor". Once the bands have been ground-truthed,
change `short_label()` in `backend/app/palette.py` and re-run the legend build —
no frontend release needed.

Every legend row shows its number *and* its density band alongside the colour, so
the map stays readable if colours are hard to tell apart. Colours live in the
database per layer, and the API sends each polygon its own colour, so the map and
the legend cannot drift apart.

### The map

The plot screen follows normal GIS conventions rather than inventing its own:

| Control | Behaviour | Why |
|---|---|---|
| **Basemap** | Satellite / Streets / Terrain, segmented control | Mutually exclusive, so radio behaviour |
| **Overlays** | Plot boundary, checkbox | Independently toggled |
| **Survey layer** | One date at a time, radio list | Stacking two dates of the same measurement would be meaningless |
| **Opacity** | Slider on the active survey layer | Fade it to check the imagery underneath |
| **Legend** | Full ramp strip + per-class area and share | The strip shows the whole scale even when a small plot spans only a few bands |
| **Zoom to plot** | Button beside the zoom controls | Get back after panning away |
| **Click a class** | Popup with category, band and area | Query-by-click is expected on a map |

Basemaps are all declared in the style up front and switched by toggling layer
visibility. Calling `setStyle()` instead — the obvious approach — throws away
every source and layer the app added, so the plot would vanish on each switch.

**How far you can zoom, and why.** The default imagery (Esri World Imagery) is
free and needs no key, but its detail is not uniform worldwide. Measured at the
sample plots (77.29°E, 30.33°N, rural Haryana):

| Zoom | Result |
|---|---|
| z14 – z18 | Real imagery |
| z19 and deeper | A 2,521-byte placeholder reading *"Map data not yet available"* |

Esri does not return a 404 for missing tiles — it returns that grey placeholder,
which looks exactly like the app breaking. So the satellite source declares
`maxzoom: 18`, and MapLibre upscales the last real tile beyond that instead of
requesting one that does not exist.

At z18 and this latitude the imagery is **0.52 m per pixel**, so a 47 m plot is
about 90 pixels across. That is enough to see the plot and its condition classes,
not enough to see individual cane rows.

For sharper imagery, set `VITE_MAPTILER_KEY` in `frontend/.env` (free tier at
maptiler.com). The app then uses MapTiler satellite, which reaches z20 across
most of India. `frontend/src/basemap.ts` is the only file involved.

Layer order, bottom to top: basemap → analysis fill → analysis edges → plot
boundary. The boundary is drawn last because it is what the farmer orients by.

### Branding

The app uses the GEOtrans palette: navy `#1e1a5f` as the shell, amber `#f5a81b`
as the single accent.

`frontend/public/geotrans-logo.svg` is currently a **hand-built placeholder**.
Replace that file with the official asset — keep the filename and it appears
everywhere at once (login, plot list, plot screen, admin). SVG is preferred so it
stays sharp on every screen density; for a PNG, save it as `geotrans-logo.png`
and change `SRC` in `frontend/src/components/Logo.tsx`.

---

## How it fits together

### The tables

```
farmers ──< plots ──< plot_analysis >── analysis_layers ──< analysis_classes
                                                     └──< analysis_features
```

| Table | What it holds |
|---|---|
| `farmers` | One per `FARM_CODE`. Carries the login phone number. |
| `plots` | One per `UNIQ_ID`, with the full original properties kept in a `jsonb` column so nothing is lost on import. |
| `analysis_layers` | One per uploaded survey date, with its processing status. |
| `analysis_classes` | The legend for one layer: class → label + colour. |
| `analysis_features` | The raw uploaded polygons, reprojected. Kept so a later plot import can be re-clipped without re-uploading. |
| `plot_analysis` | **The derived table the app reads**: analysis cut to plot boundaries, one row per (plot, class). |

### Why an admin uploads, and a farmer never waits

Uploading the plot register runs inline — it takes about 5 seconds for 42k
plots, and the admin wants the count back immediately.

Uploading an analysis layer returns straight away and processes in the
background, because clipping takes minutes. The admin screen polls until the
status reads `ready`. Farmers only ever see layers that are both `ready` and
published, so a half-imported file is never visible.

### The admin preview

The admin's "view as farmer" is not a mock-up: it navigates to the same
`/plots/:id` route, renders the same component, and calls the same API. A
preview built from a separate code path would eventually stop matching what
farmers actually see.

What differs is only the access rule. `_readable_plot()` in
`backend/app/routers/farmer.py` builds the query with the farmer id in the
`WHERE` clause for a farmer, and without it for an admin — so a farmer's request
can never fetch the wrong plot and then reject it afterwards. An amber banner
makes the preview state obvious, naming whose land is on screen.

### Who is what: how a phone number gets its role

Checked in this order at sign-in, first match wins
(`backend/app/routers/auth.py`):

| Order | Role | How the number is recognised |
|---|---|---|
| 1 | **admin** | Listed in the `ADMIN_PHONES` setting. Configuration rather than a database row, so there is no chicken-and-egg problem creating the first one. |
| 2 | **unit_head** | Matches a row in `unit_heads`, which ties it to exactly one unit. Registered by an admin. |
| 3 | **farmer** | Matches `farmers.phone`, set from the upload or typed in by an admin. |

A number matching none of these cannot sign in at all — there is no self-service
sign-up. A number is rejected as a unit head if it already belongs to a farmer,
so one phone never has two identities.

The role and its scope are then baked into the token: a farmer's carries their
`farmer_id`, a unit head's carries their `unit_id`, an admin's carries neither
because they are not limited to one. **Routes read scope from the token, never
from the request.**

### Security

Every farmer route is filtered by the `farmer_id` inside the caller's token.
There is no endpoint that takes a farmer id from the client, so one farmer
cannot request another's data by changing a number in the URL. Verified:

| Request | Result |
|---|---|
| Farmer reads their own plot | `200` |
| Farmer reads another farmer's plot | `404` |
| Farmer reads another farmer's analysis | `404` |
| Farmer calls any admin route | `403` |
| Farmer calls the admin plot list | `403` |
| Farmer calls any unit route | `403` |
| Unit head reads a plot in their own unit | `200` |
| Unit head reads a plot in **another** unit | `404` |
| Unit head passes `unit_id` for another unit | Ignored — clamped to their own |
| Unit head uploads a layer / manages units | `403` |
| Admin reads any plot in any unit (for preview) | `200` |
| No token / invalid token | `401` |
| Unregistered number requests a code | `404` |
| A used code replayed | `400` |
| An old code after a resend | `400` |

OTP codes are stored hashed, expire after 5 minutes, allow 5 attempts, are
consumed on use, and requesting a new one invalidates the old.

---

## Run it locally

You need **Docker** and **Node.js 18+**. You do not need Python, PostgreSQL or
any GIS library on your machine — the API and database run in containers.

### 1. Start the database and API

```bash
cd crop-pulse
cp backend/.env.example backend/.env
docker compose up -d --build
```

That gives you:

- PostgreSQL 16 + PostGIS 3.5 on **localhost:5433**
- The API on **http://localhost:8010**

Database tables are created automatically on first start.

Check it is alive:

```bash
curl http://localhost:8010/health
# {"status":"ok"}
```

Interactive API documentation: **http://localhost:8010/docs**

> **Ports.** 8000 and 5173 are common defaults and were already taken on this
> machine, so Crop Pulse uses **8010** and **5174**. Override the API port with
> `API_PORT=9000 docker compose up -d`.

### 2. Start the web app

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Open **http://localhost:5174**.

### 3. Sign in as admin

The admin number is set in `backend/.env` as `ADMIN_PHONES`. Out of the box it
is `+919999999999`.

Enter that number. Because `SMS_PROVIDER=console`, no SMS is sent — the code is
printed on screen and in the API log, so you can sign in without any SMS
gateway.

---

## Load the sample data

You can do all of this from the admin UI. Here it is with `curl` so each step is
explicit.

### Get an admin token

```bash
PHONE='+919999999999'

OTP=$(curl -s -X POST http://localhost:8010/api/auth/request-otp \
  -H 'Content-Type: application/json' -d "{\"phone\":\"$PHONE\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['dev_otp'])")

TOKEN=$(curl -s -X POST http://localhost:8010/api/auth/verify-otp \
  -H 'Content-Type: application/json' -d "{\"phone\":\"$PHONE\",\"code\":\"$OTP\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
```

### 1. Import the plot register (~5 seconds)

```bash
curl -X POST http://localhost:8010/api/admin/plots/import \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@../Sample layers/Base Plot layer.geojson"
```

```json
{"farmers_created":14725,"plots_imported":42096,"features_skipped":0,"phones_found":0}
```

### 2. Upload an analysis layer (returns at once, processes for a few minutes)

```bash
curl -X POST http://localhost:8010/api/admin/layers \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@../Sample layers/Status 7th Aug 2026.geojson" \
  -F "name=Crop Status" \
  -F "capture_date=2026-08-07" \
  -F "publish=true"
```

Watch it finish:

```bash
curl -s http://localhost:8010/api/admin/layers/1 -H "Authorization: Bearer $TOKEN"
# status goes pending -> processing -> ready
```

Or follow the log, which reports progress as it clips:

```bash
docker compose logs -f api
```

### 3. Give a farmer a login number

The sample file has no phone numbers, so pick a farmer and assign one. In the
admin UI: **Farmer logins** → search → type a number → Save. Or:

```bash
# find a farmer who has plots with analysis
docker exec crop-pulse-db psql -U croppulse -d croppulse -tAc \
  "SELECT f.id, f.farm_code, f.name FROM farmers f
     JOIN plots p ON p.farmer_id = f.id
     JOIN plot_analysis pa ON pa.plot_id = p.id
   GROUP BY f.id ORDER BY count(*) DESC LIMIT 5"

curl -X PUT http://localhost:8010/api/admin/farmers/<FARMER_ID>/phone \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"phone":"9876543210"}'
```

### 4. Sign in as that farmer

Sign out of the admin account, enter `9876543210`, use the code shown on screen.
You will see their plots, and each plot's map with the survey date as a tab.

---

## Project layout

```
crop-pulse/
├── docker-compose.yml          Database + API for local development
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── .env.example
│   ├── migrations/
│   │   └── 001_init.sql        Schema, applied automatically at startup
│   └── app/
│       ├── main.py             App setup, CORS, router wiring
│       ├── config.py           Settings from environment
│       ├── db.py               Connection pool + migration runner
│       ├── models.py           Request/response shapes (the API contract)
│       ├── security.py         OTP, JWT, route guards
│       ├── sms.py              SmsProvider interface + console provider
│       ├── palette.py          Legend colours and labels
│       ├── ingest.py           GeoJSON import, reprojection, clipping
│       └── routers/
│           ├── auth.py         Sign in
│           ├── farmer.py       Plots and analysis (scoped to the caller)
│           └── admin.py        Uploads and management
└── frontend/
    ├── assets/app-icon.svg     Source for every app icon size
    ├── .npmrc                  Pins this project to the public npm registry
    └── src/
        ├── api.ts              Every backend call, in one place
        ├── auth.tsx            Who is signed in
        ├── basemap.ts          Basemap definitions
        ├── types.ts            Mirrors backend/app/models.py
        ├── components/
        │   ├── PlotMap.tsx      MapLibre map, sources and layers
        │   ├── LayerControl.tsx Plot facts, basemap, overlays, legend
        │   ├── LegendEditor.tsx Admin: rename and recolour categories
        │   ├── AppHeader.tsx    The shared product shell
        │   └── Logo.tsx         GEOtrans wordmark
        └── pages/
            ├── LoginPage.tsx
            ├── FarmerEntry.tsx      Sends a farmer straight to their plot
            ├── PlotDetailPage.tsx   The map (farmer app + admin preview)
            └── AdminPage.tsx        Unit-scoped uploads, management, preview
```

**[docs/CODEBASE.md](docs/CODEBASE.md) explains every part of the code**, from
what a database actually is through to how a login travels from the phone to the
tables and back. Start there if you are new to the repository.

See [backend/README.md](backend/README.md) for the full API reference and
[frontend/README.md](frontend/README.md) for UI details.

---

## The Android app

The phone app **is** the web app — there is no second codebase. Two ways to get
it onto a phone, both shipping the same thing:

- **Direct install** (works today): a farmer opens a link and taps **Install**.
  Chrome builds a real app on the device — its own icon, its own entry in
  Settings → Apps.
- **Play Store** (optional): the same app wrapped as a **Trusted Web Activity**,
  an APK that opens your site full screen. This is what banks and airlines
  usually ship. It costs US$25 and needs a signing key and a privacy policy, but
  gives you a store listing.

Day to day you do not touch it: `npm run dev` in a browser is far faster for
building screens, and `npm run dev` already listens on your network so you can
open the real thing on a phone at `http://<your-computer-ip>:5174`.

When you are ready to package and publish, **[docs/DEPLOY-ANDROID.md](docs/DEPLOY-ANDROID.md)**
covers it end to end.

One consequence of the design worth knowing: colours, categories, layers and all
data come **from the API**, so new survey dates, renamed categories and backend
fixes reach farmers immediately, with no app release. Only UI changes need a new
version installed on each phone.

---

## Deploying

**[docs/DEPLOY.md](docs/DEPLOY.md)** — one guide, start to finish, written for
someone who has not deployed a server before. Every step explains what it does
and why.

It gets you live on AWS (Parts 1–4, about two hours, ~US$20–25/month), then turns
deploying into `git push` with a **staging** environment (Part 5, ~45 minutes,
~US$1/month more) using the workflows already in `.github/workflows/`.

**[docs/DEPLOY-ANDROID.md](docs/DEPLOY-ANDROID.md)** — the Play Store: the
signing key, the paperwork Google requires, and the release tracks.

---

## Before you go live

- [ ] **Set a real `JWT_SECRET`.** Generate one with
      `python -c "import secrets; print(secrets.token_urlsafe(48))"`. The default
      is a placeholder and anyone who knows it can mint tokens.
- [ ] **Set `ADMIN_PHONES`** to your real numbers.
- [ ] **Wire up a real SMS provider.** With `SMS_PROVIDER=console` the OTP is
      returned in the API response — fine locally, unacceptable in production.
      See below.
- [ ] **Serve over HTTPS.** Required for the app to be installable at all.
- [ ] **Restrict `CORS_ORIGINS`** to your real domains.
- [ ] **Check the satellite imagery licence.** The app uses Esri World Imagery,
      which needs no API key and is convenient for development. Confirm it suits
      your commercial use, or switch to a keyed provider — only
      `frontend/src/basemap.ts` changes.
- [ ] **Schedule database backups.**

### About SMS in India

Sending transactional SMS to Indian numbers requires **TRAI DLT registration**:
you register your business, your sender ID, and each message template with a
telecom operator's DLT portal. This is commercial paperwork and takes days to
weeks. It is not a code change.

That is exactly why the console provider exists — the entire app can be built
and tested before any of it is done.

When you are ready, add a class to `backend/app/sms.py`:

```python
class Msg91SmsProvider(SmsProvider):
    def send_otp(self, phone: str, code: str) -> None:
        httpx.post("https://control.msg91.com/api/v5/otp", json={...})

_PROVIDERS = {"console": ConsoleSmsProvider, "msg91": Msg91SmsProvider}
```

then set `SMS_PROVIDER=msg91`. Nothing else changes — the OTP returned in API
responses switches itself off as soon as the provider is not `console`.

MSG91 or Kaleyra are the usual choices for India because they help with DLT.
AWS SNS technically works but its India SMS support is restricted and still
requires DLT.

---

## Troubleshooting

**`docker compose up` fails to connect to Docker**
Rancher Desktop or Docker Desktop is not running. Start it and wait for the
whale icon to settle.

**Port already allocated**
Something else uses that port. `API_PORT=9000 docker compose up -d` for the API;
change `server.port` in `frontend/vite.config.ts` for the web app.

**`npm install` fails with a 401 or a login prompt**
Your global `~/.npmrc` points at a private registry. `frontend/.npmrc` already
overrides this for the project — make sure you run `npm install` from inside
`frontend/`.

**`python3 -m venv` fails with `pyexpat` / `libexpat` errors**
Homebrew's Python is linked against a newer libexpat than macOS provides. You do
not need host Python for this project — everything runs in Docker. If you want
it anyway, `brew reinstall python@3.12` usually fixes it.

**A layer is stuck on `processing`**
Check `docker compose logs -f api`. Progress is logged as it clips. Failures set
the status to `failed` with the reason, visible in the admin table.

**A farmer sees "This number is not registered"**
No farmer row carries that number. Set one from the admin screen under **Farmer
logins**.

**The map says "Map data not yet available" when zoomed in**
That is the imagery provider's placeholder tile, not an app error: Esri has no
imagery at that zoom for that location. The satellite source is capped at the
depth that really exists (z18 for the sample area), so this should not appear.
If you deploy elsewhere and see it, measure the real depth and adjust `maxzoom`
in `frontend/src/basemap.ts`, or set `VITE_MAPTILER_KEY` for deeper coverage.

**The map is blank, or the plot boundary does not appear**
The map shows an error banner if the style or a source fails, so check there
first. Otherwise: satellite tiles need internet access, and `VITE_API_BASE_URL`
must be reachable.

If you upgraded MapLibre while `npm run dev` was running, stop it, delete
`frontend/node_modules/.vite`, and start it again — a stale pre-bundle serves a
mismatched copy of the library.

**Vite logs "maplibre-gl-worker.mjs ... does not exist"**
MapLibre ships its worker as a separate entry that Vite's pre-bundler cannot
rewrite; the worker then fails to start and the map renders nothing.
`vite.config.ts` already excludes MapLibre from pre-bundling to avoid this. If
you see it again, delete `frontend/node_modules/.vite` and restart.
