"""Admin routes: upload data, manage layers, attach login numbers to farmers."""

import logging
import shutil
import uuid
from datetime import date
from pathlib import Path

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)

from app.config import get_settings
from app.db import cursor
from app.ingest import detect_srid, import_analysis_layer, import_plots
from app.models import (
    AdminLayer,
    ClassStyleUpdate,
    PlotSearchPage,
    FarmerPhoneUpdate,
    LayerUpdate,
    PlotImportResult,
    Unit,
    UnitAnalyticsCode,
    UnitHead,
    UnitHeadCreate,
    UnitRename,
    Viewer,
    ViewerCreate,
)
from app.plot_search import DEFAULT_PAGE_SIZE, search_plots
from app.security import normalise_phone, require_admin

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def _save_upload(upload: UploadFile) -> Path:
    """Stream an upload to disk.

    Copied in chunks rather than read into memory, because these files are large
    and the API should not need hundreds of megabytes of RAM to accept one.
    """
    if not (upload.filename or "").lower().endswith((".geojson", ".json")):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Upload a .geojson or .json file"
        )

    upload_dir = Path(get_settings().upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    destination = upload_dir / f"{uuid.uuid4().hex}_{Path(upload.filename).name}"

    with destination.open("wb") as out:
        shutil.copyfileobj(upload.file, out, length=1024 * 1024)
    return destination


# ------------------------------------------------------------------ units ---

@router.get("/units", response_model=list[Unit])
def list_units() -> list[Unit]:
    """Every unit, with how much data each currently holds."""
    with cursor() as cur:
        cur.execute(
            """
            SELECT u.id, u.name,
                   (SELECT count(*) FROM plots p WHERE p.unit_id = u.id)
                       AS plot_count,
                   (SELECT count(*) FROM analysis_layers l WHERE l.unit_id = u.id)
                       AS layer_count,
                   (SELECT count(*) FROM unit_heads h WHERE h.unit_id = u.id)
                       AS head_count,
                   u.analytics_code
            FROM units u
            ORDER BY u.sort_order, u.id
            """
        )
        return [Unit(**row) for row in cur.fetchall()]


@router.put("/units/{unit_id}", response_model=Unit)
def rename_unit(unit_id: int, payload: UnitRename) -> Unit:
    """Give a unit its real name instead of the seeded 'Unit N'."""
    name = payload.name.strip()
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A unit needs a name")
    with cursor() as cur:
        cur.execute("SELECT id FROM units WHERE name = %s AND id <> %s", (name, unit_id))
        if cur.fetchone():
            raise HTTPException(status.HTTP_409_CONFLICT, "That name is already used")
        cur.execute("UPDATE units SET name = %s WHERE id = %s", (name, unit_id))
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Unit not found")
    return next(u for u in list_units() if u.id == unit_id)


@router.put("/units/{unit_id}/analytics", response_model=Unit)
def set_unit_analytics_code(unit_id: int, payload: UnitAnalyticsCode) -> Unit:
    """Say which mill this unit is in the monitoring dashboard.

    Separate from the rename above because the two change for different reasons:
    the name is whatever the mill calls the unit today, the code is fixed by the
    dashboard's own data. Renaming must never silently break the link.

    A code held by another unit **moves** here. One unit, one mill, so somebody
    has to lose it, and refusing would only mean the admin does the same thing in
    two steps — clear it there, set it here — with an error in between. The admin
    is stating a fact about this unit; the previous holder was wrong. The caller
    is told which unit lost it, because that unit's head loses their dashboard.
    """
    code = (payload.code or "").strip().upper() or None
    with cursor() as cur:
        # Both statements are one transaction, so the unique index on
        # analytics_code never sees the moment where two units hold the code.
        if code is not None:
            cur.execute(
                "UPDATE units SET analytics_code = NULL "
                "WHERE analytics_code = %s AND id <> %s",
                (code, unit_id),
            )
        cur.execute(
            "UPDATE units SET analytics_code = %s WHERE id = %s", (code, unit_id)
        )
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Unit not found")
    return next(u for u in list_units() if u.id == unit_id)


def _require_unit(unit_id: int) -> None:
    with cursor() as cur:
        cur.execute("SELECT id FROM units WHERE id = %s", (unit_id,))
        if cur.fetchone() is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown unit")


# ------------------------------------------------------------ plot register --

@router.post("/plots/import", response_model=PlotImportResult)
def upload_plot_register(
    file: UploadFile = File(..., description="Plot boundary GeoJSON"),
    unit_id: int = Form(..., description="The unit these plots belong to"),
    srid: int | None = Form(None, description="Override the file's declared CRS"),
) -> PlotImportResult:
    """Load or refresh the plot register.

    Runs inline rather than in the background: the caller wants to know straight
    away how many farmers and plots landed, and this file is the smaller of the
    two.
    """
    _require_unit(unit_id)
    path = _save_upload(file)
    try:
        stats = import_plots(path, unit_id, srid)
    except Exception as exc:
        log.exception("Plot import failed")
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"Could not import that file: {exc}"
        ) from exc
    finally:
        # The register lives in the database now; the file is working space.
        # Left behind, every re-import of every unit accumulates another copy.
        path.unlink(missing_ok=True)

    note = (
        f"{stats.phones_found} phone numbers found in the file."
        if stats.phones_found
        else "No phone numbers in this file - assign them per farmer before farmers can log in."
    )
    return PlotImportResult(
        farmers_created=stats.farmers_created,
        farmers_updated=stats.farmers_updated,
        plots_imported=stats.plots_imported,
        features_skipped=stats.features_skipped,
        phones_found=stats.phones_found,
        message=f"Imported {stats.plots_imported} plots. {note}",
    )


# ---------------------------------------------------------- analysis layers --

@router.post("/layers", response_model=AdminLayer, status_code=status.HTTP_201_CREATED)
def upload_analysis_layer(
    background: BackgroundTasks,
    file: UploadFile = File(..., description="Analysis GeoJSON for one survey date"),
    unit_id: int = Form(..., description="The unit this survey covers"),
    name: str = Form(...),
    capture_date: date = Form(..., description="The date this analysis represents"),
    description: str | None = Form(None),
    publish: bool = Form(True, description="Make it visible to farmers when ready"),
    srid: int | None = Form(None, description="Override the file's declared CRS"),
) -> AdminLayer:
    """Accept an analysis layer and process it in the background.

    Clipping a large layer against every plot takes minutes, far longer than an
    HTTP request should stay open. So we register the layer, return immediately,
    and let the admin screen poll `status` until it reads 'ready'.
    """
    _require_unit(unit_id)
    path = _save_upload(file)
    source_srid = srid or detect_srid(path)

    with cursor() as cur:
        cur.execute(
            "INSERT INTO analysis_layers "
            "(unit_id, name, capture_date, description, is_published, "
            " source_filename, source_srid) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (unit_id, name, capture_date, description, publish, file.filename,
             source_srid),
        )
        layer_id = cur.fetchone()["id"]

    background.add_task(import_analysis_layer, layer_id, unit_id, path, source_srid)
    return _get_layer(layer_id)


_LAYER_SELECT = """
SELECT l.*, u.name AS unit_name
FROM analysis_layers l
LEFT JOIN units u ON u.id = l.unit_id
"""


@router.get("/layers", response_model=list[AdminLayer])
def list_layers(unit_id: int | None = None) -> list[AdminLayer]:
    """All layers, or just one unit's, newest survey first."""
    where = "WHERE l.unit_id = %s" if unit_id else ""
    with cursor() as cur:
        cur.execute(
            f"{_LAYER_SELECT} {where} ORDER BY l.capture_date DESC, l.id DESC",
            (unit_id,) if unit_id else (),
        )
        return [AdminLayer(**row) for row in cur.fetchall()]


def _get_layer(layer_id: int) -> AdminLayer:
    with cursor() as cur:
        cur.execute(f"{_LAYER_SELECT} WHERE l.id = %s", (layer_id,))
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Layer not found")
    return AdminLayer(**row)


@router.get("/layers/{layer_id}", response_model=AdminLayer)
def get_layer(layer_id: int) -> AdminLayer:
    """Poll this after an upload to watch it move to 'ready'."""
    return _get_layer(layer_id)


@router.patch("/layers/{layer_id}", response_model=AdminLayer)
def update_layer(layer_id: int, payload: LayerUpdate) -> AdminLayer:
    """Rename a layer, or show/hide it from farmers."""
    changes = payload.model_dump(exclude_none=True)
    if not changes:
        return _get_layer(layer_id)

    assignments = ", ".join(f"{column} = %s" for column in changes)
    with cursor() as cur:
        cur.execute(
            f"UPDATE analysis_layers SET {assignments} WHERE id = %s",
            (*changes.values(), layer_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Layer not found")
    return _get_layer(layer_id)


@router.delete("/layers/{layer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_layer(layer_id: int) -> None:
    """Remove a layer and everything derived from it."""
    with cursor() as cur:
        cur.execute("DELETE FROM analysis_layers WHERE id = %s", (layer_id,))
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Layer not found")


@router.get("/layers/{layer_id}/classes")
def get_layer_classes(layer_id: int) -> list[dict]:
    """The legend for a layer, in display order."""
    with cursor() as cur:
        cur.execute(
            "SELECT class_id, label, detail, color, class_name, sort_order "
            "FROM analysis_classes WHERE layer_id = %s ORDER BY sort_order",
            (layer_id,),
        )
        rows = cur.fetchall()
    if not rows:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "This layer has no classes yet"
        )
    return rows


@router.put("/layers/{layer_id}/classes")
def set_layer_classes(layer_id: int, payload: ClassStyleUpdate) -> list[dict]:
    """Rename classes and recolour them.

    The API sends each polygon its own colour, so a change here reaches the map
    and the legend together on the farmer's next request -- no reprocessing of
    the layer and no app release.
    """
    with cursor() as cur:
        cur.execute("SELECT class_id FROM analysis_classes WHERE layer_id = %s",
                    (layer_id,))
        known = {row["class_id"] for row in cur.fetchall()}
        if not known:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Layer not found")

        unknown = {c.class_id for c in payload.classes} - known
        if unknown:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"This layer has no class {sorted(unknown)[0]}",
            )

        for style in payload.classes:
            label = style.label.strip()
            if not label:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, "Every class needs a name"
                )
            cur.execute(
                "UPDATE analysis_classes SET label = %s, color = %s "
                "WHERE layer_id = %s AND class_id = %s",
                (label, style.color.lower(), layer_id, style.class_id),
            )
    return get_layer_classes(layer_id)


# ------------------------------------------------------------------ plots ---

@router.get("/plots", response_model=PlotSearchPage)
def search_plots_for_admin(
    search: str | None = None,
    unit_id: int | None = None,
    limit: int = DEFAULT_PAGE_SIZE,
    offset: int = 0,
) -> PlotSearchPage:
    """Find plots so an admin can preview what a given farmer sees.

    Paged, because the register runs to tens of thousands of plots: the response
    carries the true total so the screen can say "50 of 1,284" and fetch more on
    demand. Searchable by farmer name, farm code, village or plot id.
    """
    return PlotSearchPage(
        **search_plots(search=search, unit_id=unit_id, limit=limit, offset=offset)
    )


# ------------------------------------------------------------- unit heads ---

@router.get("/units/{unit_id}/heads", response_model=list[UnitHead])
def list_unit_heads(unit_id: int) -> list[UnitHead]:
    """Everyone who oversees this unit."""
    with cursor() as cur:
        cur.execute(
            "SELECT id, phone, name, unit_id FROM unit_heads "
            "WHERE unit_id = %s ORDER BY name, phone",
            (unit_id,),
        )
        return [UnitHead(**row) for row in cur.fetchall()]


@router.post(
    "/units/{unit_id}/heads",
    response_model=UnitHead,
    status_code=status.HTTP_201_CREATED,
)
def add_unit_head(unit_id: int, payload: UnitHeadCreate) -> UnitHead:
    """Add someone to a unit's overseers.

    A unit may have as many as it needs — a big unit is rarely one person's job,
    and the table never required otherwise; only this route used to, by deleting
    the previous head on every write.

    What stays enforced is one role per number. A phone already signing in as a
    farmer, a read-only admin, or the head of a *different* unit is rejected
    rather than quietly shadowed: sign-in takes the first match, so granting the
    same number twice would silently take away whichever role loses the race.
    """
    _require_unit(unit_id)
    phone = normalise_phone(payload.phone)

    with cursor() as cur:
        cur.execute("SELECT unit_id FROM unit_heads WHERE phone = %s", (phone,))
        existing = cur.fetchone()
        if existing:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "That number already heads this unit"
                if existing["unit_id"] == unit_id
                else "That number heads another unit",
            )
        cur.execute("SELECT id FROM viewers WHERE phone = %s", (phone,))
        if cur.fetchone():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "That number is a read-only admin. Remove them there first.",
            )
        cur.execute("SELECT id FROM farmers WHERE phone = %s", (phone,))
        if cur.fetchone():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "That number already belongs to a farmer. Use a different one.",
            )

        cur.execute(
            "INSERT INTO unit_heads (phone, name, unit_id) VALUES (%s, %s, %s) "
            "RETURNING id, phone, name, unit_id",
            (phone, (payload.name or "").strip() or None, unit_id),
        )
        return UnitHead(**cur.fetchone())


@router.delete(
    "/units/{unit_id}/heads/{head_id}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_unit_head(unit_id: int, head_id: int) -> None:
    """Remove one overseer, so that number can no longer sign in.

    Scoped by unit as well as id, so a mistyped unit cannot delete somebody
    else's head.
    """
    with cursor() as cur:
        cur.execute(
            "DELETE FROM unit_heads WHERE id = %s AND unit_id = %s",
            (head_id, unit_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "That unit has no head")


# ----------------------------------------------------------------- farmers ---

@router.get("/farmers")
def search_farmers(search: str | None = None, limit: int = 50) -> list[dict]:
    """Find farmers by name, farm code or phone.

    Mainly used to attach a login number to a farmer whose upload had none.
    """
    pattern = f"%{(search or '').strip()}%"
    with cursor() as cur:
        cur.execute(
            """
            SELECT f.id, f.farm_code, f.name, f.phone, count(p.id) AS plot_count
            FROM farmers f
            LEFT JOIN plots p ON p.farmer_id = f.id
            WHERE %s = '%%%%'
               OR f.name ILIKE %s OR f.farm_code ILIKE %s OR f.phone ILIKE %s
            GROUP BY f.id
            ORDER BY f.name NULLS LAST
            LIMIT %s
            """,
            (pattern, pattern, pattern, pattern, min(limit, 200)),
        )
        return cur.fetchall()


@router.put("/farmers/{farmer_id}/phone")
def set_farmer_phone(farmer_id: int, payload: FarmerPhoneUpdate) -> dict:
    """Give a farmer the phone number they will log in with."""
    phone = normalise_phone(payload.phone)
    with cursor() as cur:
        cur.execute("SELECT id FROM farmers WHERE phone = %s AND id <> %s", (phone, farmer_id))
        if cur.fetchone():
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Another farmer already uses that number"
            )
        cur.execute(
            "UPDATE farmers SET phone = %s, updated_at = now() WHERE id = %s "
            "RETURNING id, farm_code, name, phone",
            (phone, farmer_id),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Farmer not found")
    return row


# ----------------------------------------------------------- read-only admins ---

@router.get("/viewers", response_model=list[Viewer])
def list_viewers() -> list[Viewer]:
    """Everyone who may see the whole mill without changing any of it."""
    with cursor() as cur:
        cur.execute("SELECT id, phone, name FROM viewers ORDER BY name, phone")
        return [Viewer(**row) for row in cur.fetchall()]


@router.post("/viewers", response_model=Viewer, status_code=status.HTTP_201_CREATED)
def add_viewer(payload: ViewerCreate) -> Viewer:
    """Grant the mill-wide read-only view to a number.

    Rejects a number that already signs in as something else, for the same
    reason `set_unit_head` does: one phone is one person with one role, and
    quietly shadowing a farmer's login would take their own plots away from
    them — sign-in resolves to the first match, and this role is checked first.
    """
    phone = normalise_phone(payload.phone)
    with cursor() as cur:
        cur.execute("SELECT id FROM viewers WHERE phone = %s", (phone,))
        if cur.fetchone():
            raise HTTPException(
                status.HTTP_409_CONFLICT, "That number already has this access"
            )
        cur.execute("SELECT id FROM unit_heads WHERE phone = %s", (phone,))
        if cur.fetchone():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "That number heads a unit. Remove them there first.",
            )
        cur.execute("SELECT id FROM farmers WHERE phone = %s", (phone,))
        if cur.fetchone():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "That number already belongs to a farmer. Use a different one.",
            )
        cur.execute(
            "INSERT INTO viewers (phone, name) VALUES (%s, %s) "
            "RETURNING id, phone, name",
            (phone, (payload.name or "").strip() or None),
        )
        return Viewer(**cur.fetchone())


@router.delete("/viewers/{viewer_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_viewer(viewer_id: int) -> None:
    """Revoke the access, so that number can no longer sign in."""
    with cursor() as cur:
        cur.execute("DELETE FROM viewers WHERE id = %s", (viewer_id,))


# ------------------------------------------------------------------- stats ---

@router.get("/stats")
def get_stats() -> dict:
    """Counts for the admin dashboard."""
    with cursor() as cur:
        cur.execute(
            """
            SELECT (SELECT count(*) FROM farmers)                        AS farmers,
                   (SELECT count(*) FROM farmers WHERE phone IS NOT NULL) AS farmers_with_phone,
                   (SELECT count(*) FROM plots)                          AS plots,
                   (SELECT count(*) FROM analysis_layers)                AS layers,
                   (SELECT count(*) FROM analysis_layers
                     WHERE status = 'ready' AND is_published)            AS published_layers,
                   (SELECT count(*) FROM plot_analysis)                  AS analysis_pieces,
                   (SELECT count(*) FROM units)                          AS units
            """
        )
        return cur.fetchone()
