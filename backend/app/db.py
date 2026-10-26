"""Database access.

We use plain SQL through psycopg rather than an ORM. Almost every interesting
query in this app is spatial (`ST_Intersection`, `ST_AsGeoJSON`, ...), and those
read far more clearly as SQL than as ORM expressions.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.config import get_settings

_pool: ConnectionPool | None = None

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def get_pool() -> ConnectionPool:
    """The shared connection pool, created on first use."""
    global _pool
    if _pool is None:
        settings = get_settings()
        _pool = ConnectionPool(
            conninfo=settings.database_url,
            min_size=settings.db_pool_min,
            max_size=settings.db_pool_max,
            kwargs={"row_factory": dict_row},
            open=True,
        )
    return _pool


@contextmanager
def connection() -> Iterator:
    """A pooled connection. Commits on success, rolls back on error."""
    with get_pool().connection() as conn:
        yield conn


@contextmanager
def cursor() -> Iterator:
    """A cursor on a pooled connection, for the common single-query case."""
    with connection() as conn, conn.cursor() as cur:
        yield cur


def run_migrations() -> list[str]:
    """Apply any migration files that have not run yet.

    Migrations are numbered .sql files. A `schema_migrations` table records which
    ones have been applied, so this is safe to call on every startup.
    """
    applied: list[str] = []
    with connection() as conn, conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "  filename TEXT PRIMARY KEY,"
            "  applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
        )
        cur.execute("SELECT filename FROM schema_migrations")
        done = {row["filename"] for row in cur.fetchall()}

        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in done:
                continue
            cur.execute(path.read_text())
            cur.execute(
                "INSERT INTO schema_migrations (filename) VALUES (%s)", (path.name,)
            )
            applied.append(path.name)
    return applied
