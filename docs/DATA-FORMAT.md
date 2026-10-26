# Data format — what your GeoJSON files must contain

Read this before preparing the next upload. Everything here is taken from
`backend/app/ingest.py`; if you change one, change the other.

The short version: **property names are matched exactly, and they are
case-sensitive.** `FARM_CODE` works, `farm_code` and `Farm_Code` do not.

---

## File 1 — the plot register

One feature per plot. Geometry must be `Polygon` or `MultiPolygon`.

### Required — a feature without these is skipped

| Property | Type | What it is |
|---|---|---|
| `FARM_CODE` | text | **The farmer's identity.** Everything hangs off this — see the warning below. |
| `UNIQ_ID` | text/number | **The plot's identity.** Must be unique across the whole file. |
| *(geometry)* | Polygon / MultiPolygon | The boundary |

The importer counts what it skips and reports it as `features_skipped`, so if
that number is not zero, something in your file is missing one of the three.

### Optional — stored and displayed when present

| Property | Type | Shown as |
|---|---|---|
| `FARM_NAME` | text | The farmer's name |
| `VILLAGE` | text | Plot title on the map screen |
| `AREA_NAME` | text | Area |
| `ZONE` | text | Zone |
| `VAR_NAME` | text | Variety (e.g. CO-239) |
| `SurveyDate` | text | Survey date. `YYYY/MM/DD` or `YYYY-MM-DD` |
| `Survey_Are` | number | Surveyed area **in acres** (see below) |

### Phone number — any one of these names

```
PHONE   MOBILE   PHONE_NO   MOBILE_NO   PHONE_NUM   CONTACT
```

The first one found wins. Values are cleaned of spaces, dashes and brackets; a
10-digit number gets `+91`. **A farmer cannot sign in until a number exists**,
either from the file or typed into the admin screen.

### Nothing is ever lost

Every property in the source feature — including ones not listed above — is
stored verbatim in a `jsonb` column. Adding a new column to your export never
breaks the import and never needs a migration. It simply will not be *displayed*
until someone asks for it.

---

## File 2 — the analysis layer (one per survey date, per unit)

| Property | Type | Required | What it is |
|---|---|---|---|
| `Class_Id` | integer | **yes** | Which category this polygon belongs to |
| `Class_Name` | text | no | Source description. Used to derive the density band shown in the legend. |

Categories are discovered from the file: whatever distinct `Class_Id` values
appear become the categories, and they are coloured automatically from the brand
ramp. Eight is expected but not required. You can then rename and recolour them
in the admin screen.

---

## Two things that will bite you if you do not know them

### `Survey_Are` is in acres

Across all 42,096 plots in the sample, `Survey_Are` correlates with the true
polygon area at **0.9986** once converted with `1 acre = 0.404686 ha`. It is
acres, not hectares. The app stores both and labels them, and separately
computes a **mapped area** from the boundary coordinates themselves.

If your future exports switch to hectares, say so — `import_plots` in
`ingest.py` does the conversion in one line and would need changing.

### Keep `FARM_CODE` stable between uploads

`FARM_CODE` *is* the farmer. On re-upload:

- Same `FARM_CODE` → the existing farmer is updated. **Their phone number and
  login survive.**
- New `FARM_CODE` → a new farmer is created, with no phone number, who cannot
  sign in until one is set.

So if a farmer's code changes between exports, you get a second farmer record
rather than an update, and they lose their login. The same applies to `UNIQ_ID`
for plots: same id updates the plot, a new id creates a second one.

---

## Coordinate systems

The importer reads the `crs` member at the top of the file and reprojects with
PostGIS. The sample analysis layer declares `EPSG:32643` (UTM zone 43N) and is
converted to WGS84 automatically; the plot register is already WGS84.

If a file declares nothing, WGS84 is assumed. Both upload endpoints accept an
`srid` field to override the declaration when it is wrong.

---

## Re-uploading is safe

Both files can be uploaded again as often as you like:

- **Plot register** — updates plots and farmers in place, matched on `UNIQ_ID`
  and `FARM_CODE`. It does not create duplicates, and does not wipe phone
  numbers you set by hand.
- **Analysis layer** — each upload is a new dated layer. To replace one, delete
  the old date and upload again.

Uploads are scoped to a unit, so loading Unit 2's register cannot disturb
Unit 1's.
