"""Everything the farmer-facing app reads.

Every query here is filtered by the `farmer_id` in the caller's token, so a
farmer can only ever retrieve their own land -- there is no route that takes a
farmer id from the client.
"""

import json

from fastapi import APIRouter, Depends, HTTPException, status

from app.db import cursor
from app.farmers import load_profile
from app.models import (
    AnalysisClass,
    ClassBreakdown,
    FarmerProfile,
    LayerSummary,
    PlotAnalysis,
    PlotDetail,
    PlotSummary,
)
from app.security import CurrentUser, get_current_user, require_farmer

router = APIRouter(prefix="/api", tags=["farmer"])

HECTARES_TO_ACRES = 2.471054


def _acres(hectares: float | None) -> float | None:
    return None if hectares is None else round(hectares * HECTARES_TO_ACRES, 4)


def _readable_plot(plot_id: int, user: CurrentUser) -> dict:
    """Fetch a plot the caller is allowed to see.

    The scope is part of the query rather than a check afterwards, so there is
    no code path where the wrong plot is fetched and then rejected:

      admin      no restriction - needed to preview any farmer's view
      viewer     no restriction either, for the same reason; the difference
                 between the two is what they may write, not what they may read
      unit_head  restricted to their own unit, from their token
      farmer     restricted to their own plots, from their token

    Because all three read through the same route, a preview cannot drift from
    what the farmer actually sees.
    """
    if user.sees_all_units:
        scope = ""
    elif user.is_unit_head:
        scope = "AND p.unit_id = %(unit_id)s"
    else:
        scope = "AND p.farmer_id = %(farmer_id)s"
    with cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.uniq_id, p.village, p.area_name, p.zone, p.variety,
                   p.survey_date, p.survey_area_acres, p.survey_area_ha,
                   p.computed_area_ha, u.name AS unit_name, p.attributes,
                   f.name AS farmer_name, f.farm_code,
                   ST_AsGeoJSON(p.geom)          AS geom_json,
                   ST_X(ST_Centroid(p.geom))     AS lon,
                   ST_Y(ST_Centroid(p.geom))     AS lat,
                   ST_XMin(p.geom) AS min_lon, ST_YMin(p.geom) AS min_lat,
                   ST_XMax(p.geom) AS max_lon, ST_YMax(p.geom) AS max_lat
            FROM plots p
            LEFT JOIN units u   ON u.id = p.unit_id
            LEFT JOIN farmers f ON f.id = p.farmer_id
            WHERE p.id = %(plot_id)s """ + scope,
            {
                "plot_id": plot_id,
                "farmer_id": user.farmer_id,
                "unit_id": user.unit_id,
            },
        )
        plot = cur.fetchone()
    if plot is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plot not found")
    return plot


def _layer_summary(layer: dict) -> LayerSummary:
    """Build a layer summary, pulling its legend from `analysis_classes`."""
    with cursor() as cur:
        cur.execute(
            "SELECT class_id, label, detail, class_name, color FROM analysis_classes "
            "WHERE layer_id = %s ORDER BY sort_order",
            (layer["id"],),
        )
        classes = cur.fetchall()
    return LayerSummary(
        id=layer["id"],
        name=layer["name"],
        capture_date=layer["capture_date"],
        description=layer["description"],
        classes=[AnalysisClass(**row) for row in classes],
    )


@router.get("/me", response_model=FarmerProfile)
def get_profile(user: CurrentUser = Depends(require_farmer)) -> FarmerProfile:
    """The signed-in farmer's own details and totals."""
    profile = load_profile(farmer_id=user.farmer_id)
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Farmer not found")
    return profile


@router.get("/me/plots", response_model=list[PlotSummary])
def list_my_plots(user: CurrentUser = Depends(require_farmer)) -> list[PlotSummary]:
    """List the farmer's plots. No geometry, so the list screen loads instantly."""
    with cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.uniq_id, p.village, p.area_name, p.variety,
                   p.survey_area_acres, p.survey_area_ha, p.computed_area_ha,
                   u.name AS unit_name,
                   ST_X(ST_Centroid(p.geom)) AS lon,
                   ST_Y(ST_Centroid(p.geom)) AS lat
            FROM plots p
            LEFT JOIN units u ON u.id = p.unit_id
            WHERE p.farmer_id = %s
            ORDER BY u.sort_order, p.village, p.uniq_id
            """,
            (user.farmer_id,),
        )
        rows = cur.fetchall()
    return [
        PlotSummary(
            id=r["id"],
            uniq_id=r["uniq_id"],
            village=r["village"],
            area_name=r["area_name"],
            variety=r["variety"],
            unit_name=r["unit_name"],
            survey_area_acres=r["survey_area_acres"],
            survey_area_ha=r["survey_area_ha"],
            mapped_area_ha=r["computed_area_ha"],
            mapped_area_acres=_acres(r["computed_area_ha"]),
            centroid=[r["lon"], r["lat"]],
        )
        for r in rows
    ]


@router.get("/plots/{plot_id}", response_model=PlotDetail)
def get_plot(
    plot_id: int, user: CurrentUser = Depends(get_current_user)
) -> PlotDetail:
    """One plot with its boundary, ready to drop straight onto the map."""
    plot = _readable_plot(plot_id, user)
    boundary = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": plot["id"],
                "properties": {"uniq_id": plot["uniq_id"]},
                "geometry": json.loads(plot["geom_json"]),
            }
        ],
    }
    return PlotDetail(
        id=plot["id"],
        uniq_id=plot["uniq_id"],
        village=plot["village"],
        area_name=plot["area_name"],
        zone=plot["zone"],
        variety=plot["variety"],
        survey_date=plot["survey_date"],
        unit_name=plot["unit_name"],
        farmer_name=plot["farmer_name"],
        farm_code=plot["farm_code"],
        survey_area_acres=plot["survey_area_acres"],
        survey_area_ha=plot["survey_area_ha"],
        mapped_area_ha=plot["computed_area_ha"],
        mapped_area_acres=_acres(plot["computed_area_ha"]),
        attributes=plot["attributes"],
        centroid=[plot["lon"], plot["lat"]],
        boundary=boundary,
        bbox=[plot["min_lon"], plot["min_lat"], plot["max_lon"], plot["max_lat"]],
    )


@router.get("/plots/{plot_id}/layers", response_model=list[LayerSummary])
def list_layers_for_plot(
    plot_id: int, user: CurrentUser = Depends(get_current_user)
) -> list[LayerSummary]:
    """The analysis layers this plot actually has data for, newest first.

    A layer only appears once it is published and has produced pieces for this
    plot, so the app never offers a switch that turns on an empty layer.
    """
    _readable_plot(plot_id, user)
    with cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT l.id, l.name, l.capture_date, l.description
            FROM analysis_layers l
            JOIN plot_analysis pa ON pa.layer_id = l.id AND pa.plot_id = %s
            WHERE l.status = 'ready' AND l.is_published
            ORDER BY l.capture_date DESC, l.id DESC
            """,
            (plot_id,),
        )
        layers = cur.fetchall()
    return [_layer_summary(layer) for layer in layers]


@router.get("/plots/{plot_id}/analysis/{layer_id}", response_model=PlotAnalysis)
def get_plot_analysis(
    plot_id: int, layer_id: int, user: CurrentUser = Depends(get_current_user)
) -> PlotAnalysis:
    """One layer's classes clipped to one plot, plus the area breakdown.

    This reads the table built at upload time, so it is a plain indexed lookup
    however large the source layer was.
    """
    _readable_plot(plot_id, user)

    with cursor() as cur:
        cur.execute(
            "SELECT id, name, capture_date, description FROM analysis_layers "
            "WHERE id = %s AND status = 'ready' AND is_published",
            (layer_id,),
        )
        layer = cur.fetchone()
        if layer is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Layer not available")

        cur.execute(
            """
            SELECT pa.class_id, pa.area_ha, ST_AsGeoJSON(pa.geom) AS geom_json,
                   ac.label, ac.detail, ac.color, ac.sort_order
            FROM plot_analysis pa
            JOIN analysis_classes ac
              ON ac.layer_id = pa.layer_id AND ac.class_id = pa.class_id
            WHERE pa.plot_id = %s AND pa.layer_id = %s
            ORDER BY ac.sort_order
            """,
            (plot_id, layer_id),
        )
        rows = cur.fetchall()

    covered = sum(r["area_ha"] for r in rows)
    features = [
        {
            "type": "Feature",
            "properties": {
                "class_id": r["class_id"],
                "label": r["label"],
                "detail": r["detail"],
                "color": r["color"],
                "area_ha": round(r["area_ha"], 4),
            },
            "geometry": json.loads(r["geom_json"]),
        }
        for r in rows
    ]

    return PlotAnalysis(
        layer=_layer_summary(layer),
        plot_id=plot_id,
        covered_area_ha=round(covered, 4),
        breakdown=[
            ClassBreakdown(
                class_id=r["class_id"],
                label=r["label"],
                detail=r["detail"],
                color=r["color"],
                area_ha=round(r["area_ha"], 4),
                percent=round(100 * r["area_ha"] / covered, 2) if covered else 0.0,
            )
            for r in rows
        ],
        geojson={"type": "FeatureCollection", "features": features},
    )
