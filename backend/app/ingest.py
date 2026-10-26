"""Loading uploaded GeoJSON files into PostGIS.

There are two importers, one per kind of file:

  * `import_plots`          - the plot register (who farms what). Run once, then
                              again whenever the register changes.
  * `import_analysis_layer` - one survey date's crop-condition classes.

Both stream the file with ijson rather than `json.load`, because these files run
to tens or hundreds of megabytes and holding one fully parsed in memory costs
roughly twenty times its size on disk.

All spatial work -- reprojection, repair, intersection, area -- is done by
PostGIS. That keeps the Python side to plumbing and means the backend needs no
GDAL/GEOS install of its own.
"""

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import ijson

from app.db import connection
from app.palette import colors_for, range_detail, short_label

log = logging.getLogger(__name__)

# How many features to send to the database per round trip. Large enough that
# per-statement overhead disappears, small enough to keep memory flat.
BATCH_SIZE = 1_000

# How many plots to clip in one statement. Clipping is the slow step, so we work
# in chunks to keep transactions short and report progress as we go.
CLIP_CHUNK = 2_000

# Property names we accept as a farmer's phone number, in order of preference.
# The current export has none of these; when one appears it is picked up with no
# code change.
PHONE_KEYS = ("PHONE", "MOBILE", "PHONE_NO", "MOBILE_NO", "PHONE_NUM", "CONTACT")


# ------------------------------------------------------------------ helpers --

def detect_srid(path: Path, default: int = 4326) -> int:
    """Read the CRS declared at the top of a GeoJSON file.

    Strict GeoJSON is always WGS84, but files exported from GIS tools often carry
    a legacy `crs` member naming a projected system -- the analysis layer here is
    EPSG:32643 (UTM zone 43N). Getting this wrong puts the data in the wrong
    hemisphere, so we look rather than assume.
    """
    head = path.open("r", encoding="utf-8", errors="ignore").read(8192)
    match = re.search(r"EPSG:{1,2}(\d{4,6})", head)
    return int(match.group(1)) if match else default


def iter_features(path: Path) -> Iterator[dict[str, Any]]:
    """Yield features one at a time without loading the whole file.

    `use_float=True` makes ijson return plain floats. Its default is Decimal,
    which json.dumps cannot serialise -- and we hand geometry straight back to
    json.dumps on the way to PostGIS. Coordinates do not need Decimal's exactness.
    """
    with path.open("rb") as fh:
        yield from ijson.items(fh, "features.item", use_float=True)


def _clean(value: Any) -> Any:
    """Normalise a property value for storage.

    ijson returns Decimal for numbers, which json cannot serialise, and these
    exports use 0.0 and "NA" as stand-ins for "no value".
    """
    if isinstance(value, str):
        stripped = value.strip()
        return None if stripped in ("", "NA", "N/A") else stripped
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return value
    return int(number) if number.is_integer() else number


def _properties(feature: dict[str, Any]) -> dict[str, Any]:
    return {k: _clean(v) for k, v in (feature.get("properties") or {}).items()}


def _find_phone(props: dict[str, Any]) -> str | None:
    for key in PHONE_KEYS:
        value = props.get(key)
        if value:
            digits = re.sub(r"[^\d]", "", str(value)).lstrip("0")
            if len(digits) >= 10:
                return f"+91{digits[-10:]}" if len(digits) == 10 else f"+{digits}"
    return None


def _parse_date(value: Any) -> str | None:
    """The plot layer writes dates as 'YYYY/MM/DD'."""
    if not value:
        return None
    text = str(value).replace("/", "-")[:10]
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        return None
    return text


# ------------------------------------------------------------- plot import --

@dataclass
class PlotImportStats:
    farmers_created: int = 0
    farmers_updated: int = 0
    plots_imported: int = 0
    features_skipped: int = 0
    phones_found: int = 0


def import_plots(
    path: Path, unit_id: int, srid: int | None = None
) -> PlotImportStats:
    """Load the plot register.

    One farmer row per FARM_CODE, one plot row per UNIQ_ID, all belonging to
    `unit_id`. Re-running with an updated file refreshes existing rows instead of
    duplicating them, so a corrected export can simply be uploaded again.
    """
    srid = srid or detect_srid(path)
    stats = PlotImportStats()
    log.info("Importing plots from %s (source SRID %s)", path.name, srid)

    with connection() as conn, conn.cursor() as cur:
        batch: list[tuple] = []

        for feature in iter_features(path):
            props = _properties(feature)
            farm_code = props.get("FARM_CODE")
            uniq_id = props.get("UNIQ_ID")
            geometry = feature.get("geometry")

            # Without these three we cannot say whose land this is or where it is.
            if not farm_code or not uniq_id or not geometry:
                stats.features_skipped += 1
                continue

            phone = _find_phone(props)
            if phone:
                stats.phones_found += 1

            batch.append(
                (
                    str(farm_code),
                    props.get("FARM_NAME"),
                    phone,
                    str(uniq_id),
                    props.get("VILLAGE"),
                    props.get("AREA_NAME"),
                    props.get("ZONE"),
                    props.get("VAR_NAME"),
                    _parse_date(props.get("SurveyDate")),
                    props.get("Survey_Are"),  # acres; converted to ha in SQL
                    json.dumps(props),
                    json.dumps(geometry),
                    srid,
                    unit_id,
                )
            )

            if len(batch) >= BATCH_SIZE:
                _flush_plots(cur, batch, stats)
                batch.clear()

        if batch:
            _flush_plots(cur, batch, stats)

    log.info(
        "Plot import finished: %s plots, %s farmers created, %s skipped",
        stats.plots_imported,
        stats.farmers_created,
        stats.features_skipped,
    )
    return stats


_UPSERT_PLOT = """
WITH input AS (
    SELECT %s::text AS farm_code, %s::text AS farm_name, %s::text AS phone,
           %s::text AS uniq_id, %s::text AS village, %s::text AS area_name,
           %s::text AS zone, %s::text AS variety, %s::date AS survey_date,
           %s::double precision AS survey_area_acres, %s::jsonb AS attributes,
           %s::text AS geometry_json, %s::int AS srid, %s::bigint AS unit_id
),
-- Create the farmer if new. A phone number already on file is kept unless the
-- upload brings one, so manually assigned logins are never wiped by a re-import.
farmer AS (
    INSERT INTO farmers (farm_code, name, phone)
    SELECT farm_code, farm_name, phone FROM input
    ON CONFLICT (farm_code) DO UPDATE
        SET name       = COALESCE(EXCLUDED.name, farmers.name),
            phone      = COALESCE(EXCLUDED.phone, farmers.phone),
            updated_at = now()
    RETURNING id, (xmax = 0) AS was_created
)
INSERT INTO plots (uniq_id, farmer_id, unit_id, village, area_name, zone, variety,
                   survey_date, survey_area_acres, survey_area_ha, attributes,
                   geom, computed_area_ha)
SELECT i.uniq_id, f.id, i.unit_id, i.village, i.area_name, i.zone, i.variety,
       i.survey_date, i.survey_area_acres,
       i.survey_area_acres * 0.404686,  -- acres -> hectares
       i.attributes,
       g.geom,
       -- The area the boundary actually encloses. Casting to `geography` makes
       -- ST_Area return square metres on the ellipsoid rather than a
       -- meaningless number in squared degrees.
       ST_Area(g.geom::geography) / 10000.0
FROM input i
CROSS JOIN farmer f
-- MakeValid repairs self-intersecting rings, which are common in
-- field-surveyed boundaries and would otherwise break the clip step.
CROSS JOIN LATERAL (
    SELECT ST_Multi(ST_MakeValid(ST_Transform(
        ST_SetSRID(ST_GeomFromGeoJSON(i.geometry_json), i.srid), 4326))) AS geom
) g
ON CONFLICT (uniq_id) DO UPDATE
    SET farmer_id      = EXCLUDED.farmer_id,
        unit_id           = EXCLUDED.unit_id,
        village        = EXCLUDED.village,
        area_name      = EXCLUDED.area_name,
        zone           = EXCLUDED.zone,
        variety        = EXCLUDED.variety,
        survey_date       = EXCLUDED.survey_date,
        survey_area_acres = EXCLUDED.survey_area_acres,
        survey_area_ha    = EXCLUDED.survey_area_ha,
        attributes        = EXCLUDED.attributes,
        geom              = EXCLUDED.geom,
        computed_area_ha  = EXCLUDED.computed_area_ha
RETURNING (SELECT was_created FROM farmer)
"""


def _flush_plots(cur, batch: list[tuple], stats: PlotImportStats) -> None:
    """Write one batch of plots.

    Each row needs its farmer upserted first, so this runs the statement per
    feature inside a single transaction rather than as one bulk insert. At ~42k
    plots that is a one-off cost measured in seconds.
    """
    for row in batch:
        try:
            cur.execute(_UPSERT_PLOT, row)
            result = cur.fetchone()
        except Exception as exc:  # a single bad geometry must not stop the import
            log.warning("Skipping plot %s: %s", row[3], exc)
            cur.connection.rollback()
            stats.features_skipped += 1
            continue
        stats.plots_imported += 1
        if result and result.get("was_created"):
            stats.farmers_created += 1
        else:
            stats.farmers_updated += 1
    cur.connection.commit()


# --------------------------------------------------------- analysis import --

@dataclass
class LayerImportStats:
    feature_count: int = 0
    clipped_count: int = 0
    classes: list[tuple[int, str]] = field(default_factory=list)


def import_analysis_layer(
    layer_id: int, unit_id: int, path: Path, srid: int | None = None
) -> None:
    """Load one analysis layer and cut it to plot boundaries.

    Runs in three stages, updating `analysis_layers.status` as it goes so the
    admin screen can show progress:

      1. Load every polygon, reprojected to WGS84, into `analysis_features`.
      2. Build the legend from the class values actually present in the file.
      3. Intersect the layer with every plot and store the pieces in
         `plot_analysis`.

    Stage 3 is why the app feels instant later: the expensive spatial join
    happens once here, not on every request. It also means a farmer's response
    can only ever contain their own land.
    """
    srid = srid or detect_srid(path)
    log.info("Importing analysis layer %s from %s (SRID %s)", layer_id, path.name, srid)

    try:
        with connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE analysis_layers SET status = 'processing', source_srid = %s, "
                "error = NULL WHERE id = %s",
                (srid, layer_id),
            )
            # A re-import of the same layer starts from a clean slate.
            cur.execute("DELETE FROM analysis_features WHERE layer_id = %s", (layer_id,))
            cur.execute("DELETE FROM plot_analysis WHERE layer_id = %s", (layer_id,))

        stats = _load_analysis_features(layer_id, path, srid)
        _build_legend(layer_id, stats.classes)
        stats.clipped_count = _clip_to_plots(layer_id, unit_id)

        with connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE analysis_layers SET status = 'ready', feature_count = %s, "
                "clipped_count = %s, processed_at = %s WHERE id = %s",
                (
                    stats.feature_count,
                    stats.clipped_count,
                    datetime.now(timezone.utc),
                    layer_id,
                ),
            )
        log.info(
            "Layer %s ready: %s source polygons -> %s plot pieces",
            layer_id,
            stats.feature_count,
            stats.clipped_count,
        )
    except Exception as exc:
        log.exception("Layer %s failed to import", layer_id)
        with connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE analysis_layers SET status = 'failed', error = %s WHERE id = %s",
                (str(exc)[:2000], layer_id),
            )
        raise
    finally:
        # The polygons are in `analysis_features` now, so the upload is working
        # space rather than the record. Left behind, every survey date adds
        # another 60 MB of disk, every survey date, forever.
        path.unlink(missing_ok=True)


_INSERT_FEATURE = """
INSERT INTO analysis_features (layer_id, class_id, geom)
SELECT %s, %s,
       ST_Multi(ST_MakeValid(ST_Transform(
           ST_SetSRID(ST_GeomFromGeoJSON(%s), %s), 4326)))
"""


def _load_analysis_features(layer_id: int, path: Path, srid: int) -> LayerImportStats:
    stats = LayerImportStats()
    seen_classes: dict[int, str] = {}

    with connection() as conn, conn.cursor() as cur:
        batch: list[tuple] = []
        for feature in iter_features(path):
            props = _properties(feature)
            geometry = feature.get("geometry")
            class_id = props.get("Class_Id")
            if geometry is None or class_id is None:
                continue

            class_id = int(class_id)
            seen_classes.setdefault(
                class_id, str(props.get("Class_Name") or f"Class {class_id}")
            )
            batch.append((layer_id, class_id, json.dumps(geometry), srid))

            if len(batch) >= BATCH_SIZE:
                cur.executemany(_INSERT_FEATURE, batch)
                stats.feature_count += len(batch)
                batch.clear()
                conn.commit()
                log.info("Layer %s: loaded %s polygons", layer_id, stats.feature_count)

        if batch:
            cur.executemany(_INSERT_FEATURE, batch)
            stats.feature_count += len(batch)
            conn.commit()

    stats.classes = sorted(seen_classes.items())
    return stats


def _build_legend(layer_id: int, classes: list[tuple[int, str]]) -> None:
    """Give every class present in the file a colour and a readable label."""
    colors = colors_for(len(classes))
    with connection() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM analysis_classes WHERE layer_id = %s", (layer_id,))
        cur.executemany(
            "INSERT INTO analysis_classes "
            "(layer_id, class_id, class_name, label, detail, color, sort_order) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            [
                (
                    layer_id,
                    class_id,
                    class_name,
                    short_label(position),
                    range_detail(class_name),
                    colors[position],
                    position,
                )
                for position, (class_id, class_name) in enumerate(classes)
            ],
        )


# One row per (plot, class): every analysis polygon touching the plot is cut to
# the plot boundary, then the pieces of the same class are dissolved together.
_CLIP_CHUNK_SQL = """
INSERT INTO plot_analysis (layer_id, plot_id, class_id, area_ha, geom)
SELECT %(layer_id)s, piece.plot_id, piece.class_id,
       ST_Area(piece.geom::geography) / 10000.0, piece.geom
FROM (
    SELECT p.id AS plot_id,
           f.class_id,
           ST_Multi(ST_CollectionExtract(
               ST_UnaryUnion(ST_Collect(ST_Intersection(p.geom, f.geom))), 3)) AS geom
    FROM plots p
    JOIN analysis_features f
      ON  f.layer_id = %(layer_id)s
      AND ST_Intersects(p.geom, f.geom)
    WHERE p.id >= %(lo)s AND p.id < %(hi)s
      -- A layer only describes its own unit, so plots elsewhere are not just
      -- irrelevant, they would be wrong to colour in.
      AND p.unit_id = %(unit_id)s
    GROUP BY p.id, f.class_id
) AS piece
WHERE NOT ST_IsEmpty(piece.geom)
ON CONFLICT (layer_id, plot_id, class_id) DO NOTHING
"""


def _clip_to_plots(layer_id: int, unit_id: int) -> int:
    """Intersect the layer with the plots of its unit, a chunk at a time."""
    with connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT min(id) AS lo, max(id) AS hi FROM plots WHERE unit_id = %s",
                    (unit_id,))
        bounds = cur.fetchone()
    if not bounds or bounds["lo"] is None:
        log.warning(
            "No plots in unit %s; skipping clip for layer %s", unit_id, layer_id
        )
        return 0

    total = 0
    lo, hi = bounds["lo"], bounds["hi"] + 1
    for start in range(lo, hi, CLIP_CHUNK):
        with connection() as conn, conn.cursor() as cur:
            cur.execute(
                _CLIP_CHUNK_SQL,
                {
                    "layer_id": layer_id,
                    "unit_id": unit_id,
                    "lo": start,
                    "hi": start + CLIP_CHUNK,
                },
            )
            total += cur.rowcount
        log.info(
            "Layer %s: clipped plots %s-%s (%s pieces so far)",
            layer_id,
            start,
            start + CLIP_CHUNK,
            total,
        )
    return total
