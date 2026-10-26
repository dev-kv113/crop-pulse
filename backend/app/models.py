"""Request and response shapes for the API.

Keeping these in one file makes the API contract easy to read in a single pass,
and FastAPI turns them into the OpenAPI docs at /docs.
"""

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, Field


# -------------------------------------------------------------------- auth ---

class OtpRequest(BaseModel):
    phone: str = Field(..., examples=["9876543210"])


class OtpRequestResponse(BaseModel):
    phone: str
    message: str
    # Only populated by the console SMS provider, so local development can log
    # in without a gateway. Always null in production.
    dev_otp: str | None = None


class OtpVerifyRequest(BaseModel):
    phone: str
    code: str


class UnitContext(BaseModel):
    """Which unit a unit head signed in for."""

    id: int
    name: str
    head_name: str | None = None


class LoginResponse(BaseModel):
    token: str
    role: str
    farmer: "FarmerProfile | None" = None
    unit: "UnitContext | None" = None


class FarmerProfile(BaseModel):
    id: int
    farm_code: str
    name: str | None
    phone: str | None
    plot_count: int
    unit_count: int
    total_area_acres: float
    total_area_ha: float


# ------------------------------------------------------------------- plots ---

class PlotSummary(BaseModel):
    """Enough to list a farmer's plots without sending any geometry."""

    id: int
    uniq_id: str
    village: str | None
    area_name: str | None
    variety: str | None
    unit_name: str | None
    # Two different areas, deliberately kept apart:
    #  * survey_* is what the mill recorded when the plot was surveyed.
    #  * mapped_* is measured from the boundary coordinates themselves.
    # They usually agree closely; where they do not, the difference is worth
    # seeing rather than hiding behind one number.
    survey_area_acres: float | None
    survey_area_ha: float | None
    mapped_area_acres: float | None
    mapped_area_ha: float | None
    centroid: list[float] = Field(..., description="[longitude, latitude]")


class PlotDetail(PlotSummary):
    # Who farms this plot. Present so an admin previewing a farmer's view can be
    # shown whose land they are looking at.
    farmer_name: str | None
    farm_code: str | None
    zone: str | None
    survey_date: date | None
    attributes: dict[str, Any]
    boundary: dict[str, Any] = Field(..., description="GeoJSON FeatureCollection")
    bbox: list[float] = Field(..., description="[minLon, minLat, maxLon, maxLat]")


# ---------------------------------------------------------------- analysis ---

class AnalysisClass(BaseModel):
    class_id: int
    label: str
    detail: str | None = Field(None, description='Numeric band, e.g. "0.33 - 0.42"')
    class_name: str = Field(..., description="Original name from the uploaded file")
    color: str


class LayerSummary(BaseModel):
    """One switchable layer in the app's layer picker."""

    id: int
    name: str
    capture_date: date
    description: str | None
    classes: list[AnalysisClass]


class ClassBreakdown(BaseModel):
    class_id: int
    label: str
    detail: str | None
    color: str
    area_ha: float
    percent: float


class PlotAnalysis(BaseModel):
    layer: LayerSummary
    plot_id: int
    covered_area_ha: float
    breakdown: list[ClassBreakdown]
    geojson: dict[str, Any] = Field(..., description="GeoJSON FeatureCollection")


# ------------------------------------------------------------------- admin ---

class Unit(BaseModel):
    id: int
    name: str
    plot_count: int
    layer_count: int
    #: How many people oversee this unit. A unit may have several.
    head_count: int = 0
    #: Which mill this unit is in the monitoring dashboard, e.g. 'DEO'. Kept
    #: apart from the name because the name is the admin's to change.
    analytics_code: str | None = None


class UnitHead(BaseModel):
    """One of a unit's overseers."""

    id: int
    phone: str
    name: str | None = None
    unit_id: int


class UnitHeadCreate(BaseModel):
    """Add someone to a unit's overseers."""

    phone: str
    name: str | None = None


class Viewer(BaseModel):
    """Someone who may see every unit and change nothing."""

    id: int
    phone: str
    name: str | None = None


class ViewerCreate(BaseModel):
    phone: str
    name: str | None = None


class PlotSearchPage(BaseModel):
    total: int
    limit: int
    offset: int
    has_more: bool
    results: list[dict]


class UnitRename(BaseModel):
    name: str


class UnitAnalyticsCode(BaseModel):
    """Point a unit at its mill in the monitoring dashboard, or unlink it.

    The pattern is the one the dashboard itself accepts in its URL. Empty and
    null both clear the link, and the unit then shows no dashboard.
    """

    code: str | None = Field(None, pattern=r"^[A-Za-z0-9_-]{0,16}$")


class ClassStyle(BaseModel):
    """An admin-supplied name and colour for one class of a layer."""

    class_id: int
    label: str
    color: str = Field(..., pattern=r"^#[0-9a-fA-F]{6}$")


class ClassStyleUpdate(BaseModel):
    classes: list[ClassStyle]


class AdminLayer(BaseModel):
    id: int
    unit_id: int | None
    unit_name: str | None
    name: str
    capture_date: date
    description: str | None
    status: str
    error: str | None
    is_published: bool
    source_filename: str | None
    source_srid: int | None
    feature_count: int
    clipped_count: int
    created_at: datetime
    processed_at: datetime | None


class LayerUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    is_published: bool | None = None


class PlotImportResult(BaseModel):
    farmers_created: int
    farmers_updated: int
    plots_imported: int
    features_skipped: int
    phones_found: int
    message: str


class FarmerPhoneUpdate(BaseModel):
    """Used to attach a login number to a farmer whose upload had none."""

    phone: str
