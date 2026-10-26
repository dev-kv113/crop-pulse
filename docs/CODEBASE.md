# How Crop Analytics works, file by file

The doc to read to understand this repository. It assumes you can read code but
have not worked with databases much, so the database parts are explained from
first principles rather than assumed.

Read it in order the first time. After that, use the [file index](#the-file-index)
to jump.

---

## Contents

1. [The shape of the whole thing](#1-the-shape-of-the-whole-thing)
2. [A database, explained without jargon](#2-a-database-explained-without-jargon)
3. [What is stored, and why](#3-what-is-stored-and-why)
4. [Walkthrough: signing in](#4-walkthrough-signing-in)
5. [Walkthrough: opening a plot](#5-walkthrough-opening-a-plot)
6. [Walkthrough: an admin uploads a survey](#6-walkthrough-an-admin-uploads-a-survey)
7. [Who can see what](#7-who-can-see-what)
8. [The frontend](#8-the-frontend)
9. [How much load is this, really](#9-how-much-load-is-this-really)
10. [The file index](#the-file-index)
11. [Where to change things](#where-to-change-things)

---

## 1. The shape of the whole thing

Three pieces, each with one job:

```
   PHONE / BROWSER                 SERVER                      STORAGE
 ┌──────────────────┐      ┌────────────────────┐      ┌──────────────────┐
 │  frontend/       │ HTTP │  backend/          │ SQL  │  PostgreSQL      │
 │  React + MapLibre│─────▶│  FastAPI (Python)  │─────▶│  + PostGIS       │
 │                  │      │                    │      │                  │
 │  draws screens   │      │  decides who may   │      │  remembers       │
 │  and the map     │      │  see what          │      │  everything      │
 └──────────────────┘      └────────────────────┘      └──────────────────┘
```

- **The frontend** is what a farmer looks at. It knows how to draw a map and a
  legend. It knows nothing about how data is stored.
- **The backend** is the only thing that touches the database. Every rule about
  who may see what lives here — never in the frontend, because anyone can edit
  what runs in their own browser.
- **PostgreSQL** is the database. **PostGIS** is an add-on that teaches it about
  shapes on the earth: "do these two fields overlap", "how many hectares is
  this".

They are separate on purpose. The frontend could be replaced entirely and the
backend would not change.

---

## 2. A database

If you have not used one, here is the whole idea.

**A database is a set of tables.** A table is a grid, like one sheet in Excel:

```
  plots
  ┌────────┬──────────┬───────────┬─────────────┬──────────────────┐
  │  id    │ uniq_id  │ farmer_id │  village    │      geom        │
  ├────────┼──────────┼───────────┼─────────────┼──────────────────┤
  │ 28206  │ 1320174  │   28142   │ MACHHRAULI  │ (the boundary)   │
  │ 28205  │ 1323081  │   28142   │ MACHHRAULI  │ (the boundary)   │
  └────────┴──────────┴───────────┴─────────────┴──────────────────┘
```

Each **row** is one thing (one plot). Each **column** is one fact about it.

**Tables point at each other using ids.** The `plots` table does not repeat the
farmer's name on every row; it stores `farmer_id = 28142`, and the `farmers`
table holds the name once. That way, correcting a spelling is one edit rather
than sixty-five. Joining them back together when you need both is called a
**JOIN**.

**An index is what makes it fast.** Without one, finding a plot means the
database reads every row — 42,096 of them. An index is like the index at the
back of a book: it goes straight to the right page. This is the single reason
this app stays fast as data grows, and it is why the schema declares indexes
explicitly.

**SQL is the language you ask questions in.** `SELECT village FROM plots WHERE
id = 28206` means "give me the village of the plot whose id is 28206". This
project writes SQL directly rather than hiding it behind a translation layer,
because almost every question here is a *map* question and those read far more
clearly as SQL.

**PostGIS adds map understanding.** Ordinary databases store numbers and text. A
`geometry` column stores a *shape* — the outline of a field. PostGIS then
provides functions for it:

| Function | In plain terms |
|---|---|
| `ST_Area(geom::geography)` | How big is this shape, in square metres on the real curved earth |
| `ST_Intersects(a, b)` | Do these two shapes overlap at all |
| `ST_Intersection(a, b)` | Give me just the overlapping piece |
| `ST_Transform(geom, 4326)` | Convert coordinates from one system to another |
| `ST_AsGeoJSON(geom)` | Turn the shape into text the map can draw |

Doing this in the database rather than in Python is why the backend needs no
mapping libraries at all.

---

## 3. What is stored, and why

Ten tables. `backend/migrations/*.sql` is the authoritative definition — those
files create them, and they run automatically when the API starts.

```
   units ─────┬──< plots ──< plot_analysis >── analysis_layers ──< analysis_classes
              │      │                                │
              │   farmers                             └──< analysis_features
              └──< unit_heads              otp_codes     viewers
```

`viewers` stands alone: a read-only admin belongs to no unit, which is the whole
difference between them and a unit head.

`──<` means "one to many": one unit has many plots.

| Table | One row is | Why it exists |
|---|---|---|
| `units` | One mill unit | Data arrives one unit at a time. Eight are seeded. |
| `farmers` | One farmer | Holds the phone number they sign in with. |
| `plots` | One field | The boundary, plus who farms it and where. |
| `unit_heads` | One of a unit's overseers | Their phone, tied to one unit. A unit may have several. |
| `viewers` | One read-only admin | Their phone. Sees every unit, changes nothing. |
| `analysis_layers` | One uploaded survey date | Its name, date, unit and processing status. |
| `analysis_classes` | One category in one layer | Its name and colour. Editable by an admin. |
| `analysis_features` | One polygon from the uploaded file | The raw survey, kept as it arrived. |
| `plot_analysis` | The survey **cut to one plot** | **What the app actually serves.** See §6. |
| `otp_codes` | One login code | Hashed, expiring, single-use. |

### Two details worth knowing

**Nothing from your upload is thrown away.** `plots.attributes` is a `jsonb`
column — a free-form bag holding every property from the source file, including
ones the app does not display. Adding a column to your export never breaks the
import and never needs a schema change.

**A unit's dashboard code is not its name.** `units.analytics_code` holds which
mill this unit is in the crop monitoring dashboard — `DEO`, `CHP` and so on. The
name beside it is the admin's to change at any time, so deriving the code from it
would break the dashboard link the first time a unit was renamed.

**Areas are stored twice, on purpose.** `survey_area_acres` is what the mill
recorded; `computed_area_ha` is measured from the boundary's own coordinates.
They usually agree within 1%. Keeping both means a discrepancy is visible rather
than hidden behind one unlabelled number.

---

## 4. Walkthrough: signing in

Follow one login all the way through. This is the clearest way to see how the
pieces connect.

### Step 1 — the farmer types their number

`frontend/src/pages/LoginPage.tsx` calls `api.requestOtp("9812345678")`.

Everything the frontend sends goes through one function, `request()` in
`frontend/src/api.ts`. It attaches the sign-in token if there is one, sets the
content type, and turns any failure into a readable message. Having exactly one
of these is why the auth header cannot be forgotten at some call site.

### Step 2 — the server decides whether it knows this number

`backend/app/routers/auth.py`, `request_otp()`. The number is first normalised —
`9812345678`, `98123 45678` and `+919812345678` all become `+919812345678` — so
that a lookup always matches.

Then it checks four places **in order**:

```
  1. Is it in the ADMIN_PHONES setting?          -> admin
  2. Is it a row in viewers?                     -> read-only admin
  3. Is it a row in unit_heads?                  -> unit head
  4. Is it a farmers.phone?                      -> farmer
```

First match wins. Unknown numbers are told plainly that they are not registered:
there is no public sign-up, farmers are enrolled by the mill, so "not registered"
is genuinely useful rather than an information leak.

### Step 3 — a code is generated and stored, hashed

`backend/app/security.py`, `issue_otp()`:

- Generates six random digits.
- **Stores a hash of them, not the digits.** If someone stole a copy of the
  database, they would still not have any working code.
- Sets a 5-minute expiry.
- Marks any earlier unused code for that number as consumed, so a resend cannot
  leave two valid codes alive.

The code then goes to `backend/app/sms.py`. Today that is `ConsoleSmsProvider`,
which prints it to the log and returns it in the response — fine locally, and
**must be swapped before farmers use it**, or anyone could sign in as anyone.

### Step 4 — the code is checked

`verify_otp()` looks up the newest unconsumed code and rejects it if expired, if
five wrong attempts have been made, or if the hash does not match. On success it
marks the code consumed, so it can never be replayed.

### Step 5 — a token is issued

The server returns a **JWT**. Think of a wristband at an event: you show your ID
once at the gate, get a wristband, and show that instead from then on.

It carries who you are and, crucially, **your scope**:

| Role | What the token carries |
|---|---|
| farmer | `farmer_id` — the only plots they may read |
| unit head | `unit_id` — the only unit they may read |
| admin | neither, because they are not limited to one |

The server signs it with `JWT_SECRET` and checks that signature on every later
request. Anyone can *read* a token; nobody can *forge* one without the secret.

**Scope always comes from the token, never from the request.** There is no
endpoint that takes "which farmer am I" as a parameter, so there is nothing to
tamper with.

### Step 6 — the app decides which screen to show

`frontend/src/auth.tsx` stores the token in the browser and remembers the role.
`frontend/src/App.tsx` then routes:

- **farmer** → their own land (one plot goes straight to the map; several show a
  short list first)
- **unit head** → every farmer in their unit
- **admin** → the management screens

---

## 5. Walkthrough: opening a plot

A farmer taps a plot. Three requests happen.

**1. `GET /api/plots/28206`** — the plot and its boundary.

`backend/app/routers/farmer.py`, `_readable_plot()`, builds the query with the
caller's scope **inside the WHERE clause**:

```sql
WHERE p.id = 28206 AND p.farmer_id = 28142      -- farmer
WHERE p.id = 28206 AND p.unit_id  = 1           -- unit head
WHERE p.id = 28206                              -- admin
```

This matters: the wrong plot is never fetched and then rejected. It is never
fetched. A farmer asking for someone else's plot gets a plain "not found",
because for them it genuinely does not exist.

**2. `GET /api/plots/28206/layers`** — which survey dates exist for this plot.
Only layers that are finished processing *and* published appear, so a half-
imported file is never visible.

**3. `GET /api/plots/28206/analysis/1`** — the colours to draw.

This reads `plot_analysis`, the table prepared at upload time (§6). For the test
plot it returns **four shapes in about 3 KB, in roughly 5 milliseconds**. Each
shape carries its own colour, so the map and the legend are driven by one source
of truth and cannot disagree.

---

## 6. Walkthrough: an admin uploads a survey

This is the most important part of the design, and the reason the app is fast.

### The problem

The survey GeoJSON is a picture of the **whole region** — 179,982 polygons
covering farms, roads and rivers alike. It carries no plot id, so there is
nothing in the file that says which polygon belongs to whom.

To show one farmer their own land, those polygons must be cut to their plot's
boundary. Doing that when they open the app would mean searching 180,000 shapes
every single time. It would be slow for every farmer, forever.

### What the app does instead

It cuts them **once, when the admin uploads**, and stores the pieces.

`backend/app/ingest.py`, `import_analysis_layer()`, in three stages:

**Stage 1 — read the file.** Streamed with `ijson`, one polygon at a time, so a
72 MB file never sits in memory. Each is reprojected to standard latitude and
longitude on the way in — the sample file arrives in a different coordinate
system, and assuming otherwise would put the data in the wrong hemisphere.

**Stage 2 — build the legend.** Whatever distinct categories appear in the file
become the categories, coloured from the brand ramp in
`backend/app/palette.py`. An admin can rename and recolour them afterwards.

**Stage 3 — cut to plots.** For each plot in the unit, find the survey polygons
that overlap it, keep only the overlapping parts, and merge the pieces of the
same category together:

```sql
ST_Intersection(plot.geom, survey.geom)   -- just the overlapping piece
```

With the sample data this turns **179,982 source polygons into 140,333 per-plot
pieces**, and takes a few minutes.

### The trade

| | Cut on every request | Cut once at upload |
|---|---|---|
| Farmer opens a plot | Search 180,000 shapes | Look up an index. **~5 ms** |
| Cost of an upload | None | A few minutes, once |
| Who waits | Every farmer, every time | One admin, once |

That is the whole bargain: pay once, in a place where waiting is acceptable.

It also makes a data leak structurally harder. Because `plot_analysis` is already
split by plot, a farmer's response *cannot* contain someone else's land — there
is no step where everything is loaded and then filtered.

The upload returns immediately and the work continues in the background, so the
admin's browser is not left hanging for minutes. The admin screen polls until the
row reads `ready`.

---

## 7. Who can see what

Four roles, checked in order at sign-in (`backend/app/security.py` documents
this at the top of the file):

| Role | Recognised by | Can |
|---|---|---|
| **admin** | Phone in the `ADMIN_PHONES` setting | Everything: upload, delete, edit categories, appoint unit heads and read-only admins, view any farmer |
| **read-only admin** | Phone in `viewers` | See **every** unit — its farmers, any farmer's screen, its monitoring dashboard. Change nothing. |
| **unit head** | Phone in `unit_heads` | The same, for **their** unit only. A unit may have several. |
| **farmer** | Phone in `farmers.phone` | Their own plots only |

Admins live in configuration rather than a table so there is no chicken-and-egg
problem creating the first one. The other three cannot work that way: a unit head
is tied to a specific unit, and a read-only admin is created by an admin who
already exists, so neither has the bootstrapping problem that justifies a setting.

**Read scope is asked as a question, not matched against a role.** Every query
that could cross a unit boundary tests `user.sees_all_units` rather than naming
`admin` and `viewer` separately — see `_readable_plot` in `routers/farmer.py` and
`_scope_unit` in `routers/unit.py`. The two roles differ only in what they may
write, and writes are all behind `require_admin`. That is what stops the next
role being added to one query and forgotten in another.

Verified behaviour:

| Request | Result |
|---|---|
| Farmer reads their own plot | `200` |
| Farmer reads another farmer's plot | `404` |
| Farmer calls an admin or unit route | `403` |
| Unit head reads a plot in their unit | `200` |
| Unit head reads a plot in another unit | `404` |
| Unit head passes `unit_id` for another unit | Ignored — clamped to their own |
| Unit head uploads or manages | `403` |
| Admin reads any plot | `200` |
| No token, or a tampered one | `401` |
| A used code replayed | `400` |

**The admin and unit-head "view as farmer" is not a mock-up.** It navigates to
the same route, renders the same component and calls the same endpoints a farmer
uses. Only the access rule differs, and it lives in the backend. A preview built
separately would eventually stop matching reality.

---

## 8. The frontend

### How data flows

```
  page component  ──calls──▶  api.ts  ──HTTP──▶  backend
        │                                            │
        │◀──────────── plain objects ────────────────┘
        ▼
  passes them down as props to components that draw
```

Pages fetch; components draw. There is no global state library, because there is
almost no shared state — each screen loads what it needs.

### The map

`frontend/src/components/PlotMap.tsx` is the one genuinely tricky file, because
MapLibre is not a React component: it owns its own DOM and its own lifecycle.

The pattern is: **build the map once, then push data into it** as props change.
Rebuilding it on every render would reset the view every time a farmer touched a
control.

Two things there are load-bearing:

- **`ready` is React state, not a ref.** The effects that push data in are
  guarded on the map having finished loading. As a ref, that guard silently
  never re-ran once loading finished, and the map showed only the basemap. This
  was a real bug.
- **Basemaps switch by toggling visibility**, never by replacing the style.
  Replacing it would discard every layer the app added, so the plot would vanish.

### Colours come from the server

Every analysis shape arrives with its own `color`, and the map styles from that
value. The legend renders the same values. So they cannot drift, and changing the
palette is a backend change that needs no app release.

---

## 9. How much load is this, really

Measured on the sample data, not estimated.

### Storage

| Table | Rows | On disk |
|---|---|---|
| `plots` | 42,096 | 154 MB |
| `plot_analysis` | 140,333 | 75 MB |
| `analysis_features` | 179,982 | 70 MB |
| everything else | — | ~5 MB |
| **total** | | **~322 MB** |

Roughly **75 MB per additional survey date** for a unit this size. Eight units
with monthly surveys would be in the low tens of GB per year — comfortable on a
30 GB disk for the first year, and a disk resize after that.

### Memory

During a 72 MB upload with 180,000 polygons, the API used a **peak of 56 MB**,
essentially flat. The file is streamed to disk in chunks and parsed one polygon
at a time, so a bigger file does not mean more memory.

### Speed

The query behind a farmer opening a plot:

```
Index Scan using plot_analysis_layer_id_plot_id_class_id_key
  (actual time=0.045..0.048 rows=4)
```

**0.048 milliseconds.** The important part is *Index Scan*: the database jumps
straight to the rows instead of reading the table. That stays true whether the
table holds 140 thousand rows or 140 million — this is what "an index makes it
fast" means in practice.

### So how many farmers can it serve?

A farmer opening a plot costs roughly 5 ms of server time. Even allowing a
generous 20 ms each, one small server handles **dozens of requests per second**,
and a farmer checking their crop makes a handful of requests and then reads the
screen for minutes.

The limit is not the database, it is how many requests can be in flight at once —
set by `DB_POOL_MAX` (default 10 connections per API process). Raise it with
traffic, keeping `instances × DB_POOL_MAX` below the database's own limit
(100 by default).

**Lakhs of registered farmers is not the same as lakhs of simultaneous ones.**
Registered farmers cost storage, which is cheap and measured above. Simultaneous
farmers cost connections. If 500 people genuinely used it in the same second,
that is when you add a second API instance.

### The one thing that will not scale as-is

Upload processing runs as a background task **inside the API process**. Perfect
on one server. If you ever run several API instances behind a load balancer, the
job runs on whichever one received the upload and is lost if that container
restarts mid-job. Move it to a queue and a worker before scaling out. Nothing
else needs to change — `import_analysis_layer` is already a plain function taking
a layer id, a unit id and a file path.

---

## The file index

### Backend — `backend/`

| File | What it does |
|---|---|
| `app/main.py` | Starts the app, applies migrations, sets CORS, wires the routes together |
| `app/config.py` | Every setting, read from `.env`. The list of what is configurable |
| `app/db.py` | Connection pool, and the migration runner |
| `app/models.py` | The shape of every request and response — the API contract in one file |
| `app/security.py` | Phone normalising, OTP issue/verify, tokens, and the role guards |
| `app/sms.py` | How a code is delivered. Swap the provider here |
| `app/farmers.py` | Loads a farmer's profile. Shared by login and `/api/me` |
| `app/plot_search.py` | Paged plot search. Shared by the admin and unit-head screens |
| `app/palette.py` | The eight category colours and their labels |
| `app/ingest.py` | Reads uploaded GeoJSON, reprojects it, and cuts it to plots |
| `app/routers/auth.py` | Sign in |
| `app/routers/farmer.py` | Plots and analysis, scoped to the caller |
| `app/routers/unit.py` | A unit head's view of their unit |
| `app/routers/admin.py` | Uploads, layers, categories, unit heads, farmer search |
| `migrations/00*.sql` | The tables. Applied automatically, in order, once each |

### Frontend — `frontend/src/`

| File | What it does |
|---|---|
| `main.tsx` | Boots React |
| `App.tsx` | Decides which app each role sees |
| `api.ts` | Every backend call. One place for the token, errors and the base URL |
| `auth.tsx` | Who is signed in, remembered across visits |
| `types.ts` | Mirrors `backend/app/models.py` |
| `basemap.ts` | The three basemaps, and how deep each provider's imagery really goes |
| `analytics.ts` | The address of the monitoring dashboard, and a unit's link into it |
| `styles.css` | All the styling, phone first |
| `components/PlotMap.tsx` | The map |
| `components/LayerControl.tsx` | Plot facts, basemap, overlays, opacity, legend |
| `components/FarmerTable.tsx` | Paged farmer search. Shared by admin and unit head |
| `components/LegendEditor.tsx` | Renaming and recolouring categories |
| `components/AppHeader.tsx` | The shared top bar |
| `components/InstallPrompt.tsx` | "Install app" on the login screen |
| `components/Logo.tsx` | The GEOtrans wordmark |
| `pages/LoginPage.tsx` | Phone → code → in |
| `pages/FarmerEntry.tsx` | Sends a farmer to their plot, or their list |
| `pages/PlotListPage.tsx` | A farmer's plots, when they hold several |
| `pages/PlotDetailPage.tsx` | The map screen. Also the admin/unit-head preview |
| `pages/UnitHomePage.tsx` | A unit's farmers and monitoring dashboard. Shared by a unit head and a read-only admin, who additionally gets a unit picker |
| `pages/AdminPage.tsx` | Everything an admin does |

---

## Where to change things

| To change… | Edit |
|---|---|
| Category names or colours | The admin screen. No code, no release. |
| Their *defaults* for future uploads | `backend/app/palette.py` |
| Which property holds a phone number | `PHONE_KEYS` in `backend/app/ingest.py` |
| Which plot fields get their own column | `backend/app/ingest.py` plus a new migration |
| Add a real SMS gateway | `backend/app/sms.py` — one class, then set `SMS_PROVIDER` |
| Token lifetime, OTP rules, pool size | `backend/.env` |
| The basemaps | `frontend/src/basemap.ts` |
| Which dashboard a unit shows | The admin screen, under Unit. No code, no release. |
| Where that dashboard lives | `VITE_ANALYTICS_URL` in `frontend/.env` |
| Anything visual | `frontend/src/styles.css` |
| The app icon | Replace `frontend/assets/app-icon.svg`, run `npm run icons` |

### Adding a database table or column

1. Write a new numbered file in `backend/migrations/`, e.g. `006_something.sql`.
2. Restart the API. It applies anything that has not run yet and records it, so
   restarting twice is harmless.
3. Never edit a migration that has already run — it will not run again. Write
   another one.

