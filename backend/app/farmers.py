"""Loading a farmer's profile.

Two places need it -- signing in (found by phone) and the /api/me screen (found
by id) -- and the query is otherwise identical. Keeping one copy means a column
added here shows up in both, rather than in whichever one was remembered.
"""

from app.db import cursor
from app.models import FarmerProfile

_PROFILE_SQL = """
SELECT f.id, f.farm_code, f.name, f.phone,
       count(p.id)                           AS plot_count,
       count(DISTINCT p.unit_id)             AS unit_count,
       COALESCE(sum(p.survey_area_acres), 0) AS total_area_acres,
       COALESCE(sum(p.survey_area_ha), 0)    AS total_area_ha
FROM farmers f
-- LEFT JOIN, not JOIN: a farmer with no plots yet should still be found, and
-- simply reports zero, rather than looking like they do not exist.
LEFT JOIN plots p ON p.farmer_id = f.id
WHERE {where}
GROUP BY f.id
"""


def load_profile(*, phone: str | None = None, farmer_id: int | None = None):
    """Find one farmer by phone or by id. Returns None if there is no such farmer."""
    if phone is not None:
        sql, param = _PROFILE_SQL.format(where="f.phone = %s"), phone
    elif farmer_id is not None:
        sql, param = _PROFILE_SQL.format(where="f.id = %s"), farmer_id
    else:
        raise ValueError("load_profile needs either a phone or a farmer_id")

    with cursor() as cur:
        cur.execute(sql, (param,))
        row = cur.fetchone()

    if row is None:
        return None
    return FarmerProfile(
        id=row["id"],
        farm_code=row["farm_code"],
        name=row["name"],
        phone=row["phone"],
        plot_count=row["plot_count"],
        unit_count=row["unit_count"],
        total_area_acres=float(row["total_area_acres"]),
        total_area_ha=float(row["total_area_ha"]),
    )
