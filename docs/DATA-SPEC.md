# Crop Analytics — what to send us

Two files. Please read the four rules at the end; they are the things that cause
almost every problem.

| | File 1 | File 2 |
|---|---|---|
| **What** | Plot register — the boundaries and who farms them | Analysis layer — one survey pass |
| **Format** | GeoJSON (`.geojson` or `.json`) | GeoJSON (`.geojson` or `.json`) |
| **One file per** | Unit | Unit, per survey date |
| **One feature per** | Plot | Analysis polygon |
| **How often** | When the register changes | Each new survey |

Both are ordinary GeoJSON `FeatureCollection`s — the "Export to GeoJSON" option
in QGIS, ArcGIS or GDAL produces exactly the right thing. Field names below are
the **attribute/column names** in your source layer; they carry through the
export unchanged.

---

## File 1 — Plot register

One feature per plot, geometry `Polygon` or `MultiPolygon`.

### Required

A feature missing any of these three is skipped, and we are told how many were
skipped. If that number is not zero, something is missing.

| Column | Type | What it is |
|---|---|---|
| `FARM_CODE` | text | The farmer's code. This *is* the farmer's identity — see rule 3. |
| `UNIQ_ID` | text or number | The plot's code. Must be unique within the file. |
| *(geometry)* | Polygon / MultiPolygon | The plot boundary |

### Optional — included if you have it, ignored if you don't

| Column | Type | Notes |
|---|---|---|
| `FARM_NAME` | text | Farmer's name |
| `VILLAGE` | text | |
| `AREA_NAME` | text | |
| `ZONE` | text | |
| `VAR_NAME` | text | Cane variety, e.g. `CO-239` |
| `SurveyDate` | text | `YYYY/MM/DD` or `YYYY-MM-DD`. Anything else is ignored. |
| `Survey_Are` | number | Surveyed area **in acres**. Tell us if you ever switch to hectares. |

> Note the casing on the last two: `SurveyDate` and `Survey_Are` are **not**
> all-capitals like the rest. That is deliberate on our side — please match it
> exactly.

### Phone number — any one of these names

This is the only field with alternatives. The first one found wins:

```
PHONE    MOBILE    PHONE_NO    MOBILE_NO    PHONE_NUM    CONTACT
```

Spaces, dashes and brackets are stripped, as are leading zeros. A 10-digit
number gets `+91` added. Anything shorter than 10 digits is treated as no
number. **A farmer cannot log in until they have one**, so send them wherever
you have them.

### Anything else you send is kept

Extra columns are stored as-is. Adding a column to your export will never break
our import, so please don't strip anything out to "clean it up" — send what you
have.

```json
{
  "type": "FeatureCollection",
  "crs": { "type": "name", "properties": { "name": "EPSG:4326" } },
  "features": [
    {
      "type": "Feature",
      "properties": {
        "FARM_CODE": "L14182",
        "UNIQ_ID": "1336559",
        "FARM_NAME": "AABBAS",
        "VILLAGE": "LAPRA",
        "VAR_NAME": "CO-239",
        "SurveyDate": "2025/11/14",
        "Survey_Are": 1.90,
        "MOBILE": "9876543210"
      },
      "geometry": { "type": "Polygon", "coordinates": [[[77.01, 29.44], "…"]] }
    }
  ]
}
```

---

## File 2 — Analysis layer

One file per unit per survey date. One feature per analysis polygon.

| Column | Type | Required | What it is |
|---|---|---|---|
| `Class_Id` | whole number | **yes** | Which category this polygon belongs to |
| `Class_Name` | text | no | Your description of the category |
| *(geometry)* | Polygon / MultiPolygon | **yes** | |

Features without a geometry or without `Class_Id` are skipped silently, so
please check your export has both on every row.

You do not need to tell us how many categories there are or what colour they
should be — we read the distinct `Class_Id` values out of the file and colour
them here. Eight is what we normally see, but any number works.

**`Class_Name` is worth filling in.** If it contains two decimal numbers, we show
that range in the legend under the category name. So
`"Density slice range 0.3346 to 0.4183"` becomes a legend entry reading
`0.33 – 0.42`. Without two decimals in the name, the category just shows its
number.

```json
{
  "type": "FeatureCollection",
  "crs": { "type": "name", "properties": { "name": "EPSG:32643" } },
  "features": [
    {
      "type": "Feature",
      "properties": {
        "Class_Id": 5,
        "Class_Name": "Density slice range 0.3346 to 0.4183"
      },
      "geometry": { "type": "Polygon", "coordinates": [[[712345.6, 3258901.2], "…"]] }
    }
  ]
}
```

---

## Four rules that matter

### 1. Column names are case-sensitive and matched exactly

`FARM_CODE` works. `farm_code`, `Farm_Code` and `FARM CODE` do not — the column
is simply read as missing, and the feature is skipped. Please copy the names
from the tables above rather than retyping them.

### 2. Put the CRS at the top of the file

We read the projection from the `crs` member and reproject automatically, so any
system is fine — UTM 43N (`EPSG:32643`) and WGS84 (`EPSG:4326`) are both normal
here. But we only look at the **first few kilobytes** of the file, so the `crs`
member must come before the features, which is where exporters normally put it.

If a file declares nothing, we assume WGS84. Getting this wrong puts the data in
the wrong part of the world, so it is worth a glance before sending.

### 3. Keep `FARM_CODE` and `UNIQ_ID` stable between deliveries

These are how we recognise a farmer or a plot we already have.

- Same `FARM_CODE` → that farmer is **updated**, and keeps their login.
- Changed `FARM_CODE` → a **second farmer** is created, with no login, and the
  original is left behind.

The same applies to `UNIQ_ID` for plots. If codes have to change, tell us before
sending so we can handle it, rather than after.

### 4. Leave blanks blank

Empty cells, `NA` and `N/A` are all read as "no value", which is correct and
useful. Please **don't** substitute `0`, `-`, `NULL` or `Unknown` — those get
stored as if they were real values.

---

## Before you send

- [ ] One file per unit, and the unit is named in the filename
- [ ] `FARM_CODE` and `UNIQ_ID` present on every plot feature *(File 1)*
- [ ] `Class_Id` present on every feature *(File 2)*
- [ ] Column names match the tables exactly, including capitals
- [ ] `crs` declared at the top of the file
- [ ] Phone numbers included wherever you have them *(File 1)*
- [ ] Blanks left blank

Re-sending a corrected file is always safe — it updates what is already there
rather than creating duplicates. So if in doubt, send it and we will tell you
what came through.
