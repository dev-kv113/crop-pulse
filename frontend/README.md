# Crop Analytics web app

React + TypeScript + Vite, with [MapLibre GL](https://maplibre.org) for the map
and [vite-plugin-pwa](https://vite-pwa-org.netlify.app) to make the same code
installable on a phone.

See the [main README](../README.md) for setup and the Android walkthrough. This
file covers how the UI is put together.

---

## Running it

```bash
cp .env.example .env
npm install
npm run dev          # http://localhost:5174
```

| Command | Does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | TypeScript only, no output |
| `npm run icons` | Regenerate app icons from `assets/app-icon.svg` |

`npm run dev` binds to all interfaces, so you can open the app on a phone on the
same wi-fi at `http://<your-computer-ip>:5174` — the quickest way to check the
real thing without building anything native.

> **`.npmrc`**: this folder pins the project to the public npm registry. Without
> it, npm picks up whatever is in your global `~/.npmrc`, which on this machine
> is a private IBM mirror with unrelated credentials.

---

## How it is organised

```
src/
├── api.ts           Every backend call. One place for the base URL,
│                    the auth header, and error handling.
├── auth.tsx         Who is signed in. Token in localStorage.
├── basemap.ts       Basemap definitions (satellite, streets, terrain).
├── types.ts         Mirrors backend/app/models.py.
├── styles.css       All the styling, phone-first.
├── components/
│   ├── PlotMap.tsx      MapLibre map, sources and layers
│   ├── LayerControl.tsx Plot facts, basemap, overlays, opacity, legend
│   ├── LegendEditor.tsx Admin: rename and recolour categories
│   ├── AppHeader.tsx    The shared product shell
│   └── Logo.tsx         GEOtrans wordmark
└── pages/
    ├── LoginPage.tsx        Phone -> code -> in
    ├── FarmerEntry.tsx      Redirects a farmer straight to their plot
    ├── PlotDetailPage.tsx   The map screen (farmer app + admin preview)
    └── AdminPage.tsx        Unit-scoped uploads, management, preview
```

`App.tsx` decides which app you get: no token → login, `admin` → admin screen,
`farmer` → straight to their plot's map. There is no farmer list screen: a
farmer opens the app to look at their land, so the map *is* the app. Farmers
holding several plots get a switcher inside the map panel instead.

---

## Things that are the way they are for a reason

**The map is created once and then fed data.** MapLibre owns its own DOM and is
not a React component. `PlotMap` creates the map in an effect with an empty
dependency list, then pushes new data in from separate effects. If the map were
rebuilt on every render, the view would jump back to the start each time a farmer
tapped a layer.

**MapLibre is lazy-loaded.** It is by far the largest dependency. Loading it only
when a plot opens keeps the first load at ~65 KB gzipped instead of ~312 KB,
which matters a lot on a rural mobile connection.

**`HashRouter`, not `BrowserRouter`.** The packaged Android app loads the page
from the filesystem, where there is no server to fall back to `index.html` for
path-based routes.

**Basemaps switch by visibility, not `setStyle()`.** All three are declared in
the style up front. Calling `setStyle()` would discard every source and layer the
app added, so the plot and its analysis would disappear on each switch.

**`ready` is state, not a ref.** The effects that push data into the map are
guarded on the map having loaded. As a ref that guard silently never re-ran once
loading finished, so the sources stayed empty and the map showed only the
basemap — the exact symptom that looked like "no data".

**Colours come from the API.** Every analysis feature arrives with its own
`color`, and the map styles with `["get", "color"]`. The legend renders the same
values. Neither can drift from the other, and changing the palette is a backend
change that needs no frontend release.

**Controls match what they do.** Basemaps are mutually exclusive, so they get a
segmented radio control. The boundary is independent, so it gets a checkbox.
Survey dates are one-at-a-time — stacking two dates of the same measurement would
be meaningless — so they get radios. Matching the widget to the behaviour is most
of what makes a map feel like a map.

**The plot opens with the newest survey already on.** That is what the farmer
came to see, and an empty map looks broken.

**The admin preview reuses the farmer screen.** `/plots/:id` renders the same
component for both roles and calls the same endpoints, so the preview cannot
drift from the real thing. Only the access rule differs, and it lives in the
backend.

**Each legend row carries its number and density band, not just a colour.** The
ramp is ordered and readable, but colour alone should never be the only way to
tell two rows apart. The legend also shows the full scale as a strip, so a small
plot spanning three bands still communicates where those bands sit.

**Areas are shown in acres.** That is what farmers here use, and it is the unit
the source data records. The analysis breakdown is in hectares because it is
computed geometrically; both are labelled explicitly.

---

**The admin screen fills its width.** A two-column grid above 1000px, with
`.card-wide` for anything holding a table, collapsing to one column on a phone.
A fixed narrow column would leave half a laptop screen empty.

**Editing a phone number lives in the farmer row.** It was previously a separate
card at the bottom of the page, which meant scrolling past everything to reach
the one field that unblocks a farmer signing in.

## Styling

One `styles.css`, small enough to read start to finish, with no CSS framework.

Phone-first: the plot screen is a full-height map with the layer control docked
below it. Above 900px the control becomes a sidebar, as in a desktop GIS. Inputs
are 16px so iOS does not zoom on focus, and tap targets are at least 48px.

Navy chrome around a light working area, so the map stays the brightest thing on
screen and the amber accent means exactly one thing: the primary action.

---

## Branding

Navy `#1e1a5f` and amber `#f5a81b`, defined once as CSS custom properties at the
top of `styles.css`.

`public/geotrans-logo.svg` is a **placeholder**. Drop the official asset in at
that exact path and it replaces itself everywhere — login, plot list, plot
screen and admin all render `<Logo />`. For a PNG, save `geotrans-logo.png` and
change `SRC` in `src/components/Logo.tsx`.

## Changing the basemap

`src/basemap.ts` is the only file involved. It currently offers Esri World
Imagery, OpenStreetMap and Esri Topographic, none of which need an API key.

For a keyed provider, replace the `tiles` URL — for MapTiler:

```ts
tiles: [`https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${KEY}`],
```

Check the licence terms for commercial use before you ship.
