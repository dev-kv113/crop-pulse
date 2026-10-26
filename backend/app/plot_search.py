"""Looking up plots by farmer, village or plot id.

Shared by the admin screen and the unit-head screen. They differ only in whether
the unit is chosen or fixed, so keeping one query means the two views cannot
drift apart, and a fix to one is a fix to both.
"""

from typing import Any

from app.db import cursor

# What the browser gets in one request. The full register is 42k plots; sending
# them all would be a slow response and an unreadable table, so results are
# paged and the caller is told the true total.
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200


def search_plots(
    *,
    search: str | None = None,
    unit_id: int | None = None,
    limit: int = DEFAULT_PAGE_SIZE,
    offset: int = 0,
) -> dict[str, Any]:
    """One page of plots, plus how many matched in total.

    `unit_id` restricts the search to a single unit. For a unit head this is not
    optional -- it is taken from their token, never from the request.
    """
    term = (search or "").strip()
    pattern = f"%{term}%"

    clauses: list[str] = []
    params: list[Any] = []

    if unit_id is not None:
        clauses.append("p.unit_id = %s")
        params.append(unit_id)

    if term:
        clauses.append(
            "(f.name ILIKE %s OR f.farm_code ILIKE %s "
            " OR p.village ILIKE %s OR p.uniq_id ILIKE %s)"
        )
        params += [pattern] * 4

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""

    limit = max(1, min(limit, MAX_PAGE_SIZE))
    offset = max(0, offset)

    with cursor() as cur:
        # The count runs over the same filter, so "showing 50 of 1,284" is
        # always true rather than an estimate.
        cur.execute(
            f"""
            SELECT count(*) AS total
            FROM plots p
            LEFT JOIN farmers f ON f.id = p.farmer_id
            {where}
            """,
            params,
        )
        total = cur.fetchone()["total"]

        cur.execute(
            f"""
            SELECT p.id, p.uniq_id, p.village, p.variety, p.computed_area_ha,
                   f.name AS farmer_name, f.farm_code, f.phone,
                   u.name AS unit_name,
                   (SELECT count(DISTINCT pa.layer_id)
                      FROM plot_analysis pa WHERE pa.plot_id = p.id) AS layer_count
            FROM plots p
            LEFT JOIN farmers f ON f.id = p.farmer_id
            LEFT JOIN units u   ON u.id = p.unit_id
            {where}
            -- A stable order matters once results are paged: without it the
            -- database may return the same row on two different pages.
            ORDER BY f.name NULLS LAST, p.uniq_id
            LIMIT %s OFFSET %s
            """,
            [*params, limit, offset],
        )
        rows = cur.fetchall()

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(rows) < total,
        "results": rows,
    }
