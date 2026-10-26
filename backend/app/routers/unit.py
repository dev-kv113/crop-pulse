"""Routes for a unit head.

A unit head oversees one unit: they can find any farmer in it and open that
farmer's screen, but they cannot upload data, touch another unit, or change
anything.

The unit is taken from their token, never from the request, so there is no
parameter they could change to see somebody else's unit.
"""

from fastapi import APIRouter, Depends, HTTPException, status

from app.db import cursor
from app.models import PlotSearchPage
from app.plot_search import DEFAULT_PAGE_SIZE, search_plots
from app.security import CurrentUser, require_unit_head

router = APIRouter(prefix="/api/unit", tags=["unit"])


def _scope_unit(user: CurrentUser, requested: int | None) -> int:
    """Which unit this caller may look at.

    An admin or a viewer may pass one explicitly, since they oversee all of
    them. A unit head's is fixed by their token and any request parameter is
    ignored.
    """
    if user.sees_all_units:
        if requested is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Choose a unit to view"
            )
        return requested
    if user.unit_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "This account is not linked to a unit"
        )
    return user.unit_id


@router.get("/list")
def list_visible_units(user: CurrentUser = Depends(require_unit_head)) -> list[dict]:
    """Every unit this caller may open, newest data first is not the point —
    they are listed in the mill's own order.

    A read-only twin of the admin route, so a viewer can populate a unit picker
    without being given a route that also renames units and sets their heads.
    A unit head gets a one-item list rather than a 403: the picker is then the
    same component for both, showing nothing to choose.
    """
    where, params = "", ()
    if not user.sees_all_units:
        if user.unit_id is None:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "This account is not linked to a unit"
            )
        where, params = "WHERE u.id = %s", (user.unit_id,)

    with cursor() as cur:
        cur.execute(
            f"""
            SELECT u.id, u.name, u.analytics_code,
                   (SELECT count(*) FROM plots p WHERE p.unit_id = u.id)
                       AS plot_count,
                   (SELECT count(DISTINCT p.farmer_id) FROM plots p
                     WHERE p.unit_id = u.id)                       AS farmer_count
            FROM units u
            {where}
            ORDER BY u.sort_order, u.id
            """,
            params,
        )
        return cur.fetchall()


@router.get("/me")
def get_unit(
    unit_id: int | None = None, user: CurrentUser = Depends(require_unit_head)
) -> dict:
    """The unit this person oversees, with a summary of what is in it."""
    scoped = _scope_unit(user, unit_id)
    with cursor() as cur:
        cur.execute(
            """
            SELECT u.id, u.name, u.analytics_code,
                   (SELECT count(*) FROM plots p WHERE p.unit_id = u.id)
                       AS plot_count,
                   (SELECT count(DISTINCT p.farmer_id) FROM plots p
                     WHERE p.unit_id = u.id)                       AS farmer_count,
                   (SELECT count(DISTINCT p.farmer_id) FROM plots p
                      JOIN farmers f ON f.id = p.farmer_id
                     WHERE p.unit_id = u.id AND f.phone IS NOT NULL)
                       AS farmers_with_login,
                   (SELECT count(*) FROM analysis_layers l
                     WHERE l.unit_id = u.id
                       AND l.status = 'ready' AND l.is_published)  AS layer_count
            FROM units u
            WHERE u.id = %s
            """,
            (scoped,),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unit not found")
    return row


@router.get("/plots", response_model=PlotSearchPage)
def list_unit_plots(
    search: str | None = None,
    unit_id: int | None = None,
    limit: int = DEFAULT_PAGE_SIZE,
    offset: int = 0,
    user: CurrentUser = Depends(require_unit_head),
) -> PlotSearchPage:
    """Farmers and plots in this unit, paged.

    Same query the admin screen uses, with the unit fixed rather than chosen.
    """
    scoped = _scope_unit(user, unit_id)
    return PlotSearchPage(
        **search_plots(search=search, unit_id=scoped, limit=limit, offset=offset)
    )
