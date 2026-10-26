"""Crop Analytics API.

Start it with:  uvicorn app.main:app --reload
Interactive docs are then at http://localhost:8000/docs
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import cursor, get_pool, run_migrations
from app.routers import admin, auth, farmer, unit
from app.sms import get_sms_provider

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)-8s %(name)s: %(message)s"
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    applied = run_migrations()
    if applied:
        log.info("Applied migrations: %s", ", ".join(applied))

    # A layer is processed by a background task inside this process. If the API
    # is restarted or killed mid-import -- a deploy, a crash, an out-of-memory
    # kill -- that task dies with it and the row is left saying 'processing'
    # forever, with nothing running. Nothing will ever finish it, so say so and
    # let the admin upload again rather than watch a progress bar that has
    # stopped moving.
    with cursor() as cur:
        cur.execute(
            "UPDATE analysis_layers SET status = 'failed', "
            "error = 'Interrupted when the server restarted. Upload it again.' "
            "WHERE status IN ('pending', 'processing')"
        )
        if cur.rowcount:
            log.warning(
                "Marked %s interrupted layer(s) as failed", cur.rowcount
            )

    # Build the SMS provider once at startup so a missing auth key or template
    # id stops the deploy, rather than waiting to surface as a failed login for
    # the first farmer who tries.
    provider = get_sms_provider()
    log.info("SMS provider: %s", type(provider).__name__)

    # The Play Store review bypass is a standing way in, so say so on every
    # boot. A live deployment with this set and review long finished is a
    # password sitting in a config file that nobody is thinking about.
    settings = get_settings()
    if settings.review_phone.strip() or settings.review_otp.strip():
        if not (settings.review_phone.strip() and settings.review_otp.strip()):
            raise RuntimeError(
                "REVIEW_PHONE and REVIEW_OTP must be set together, or not at "
                "all. One without the other does nothing and reads as if it "
                "works."
            )
        if not settings.review_otp.strip().isdigit() or len(
            settings.review_otp.strip()
        ) != settings.otp_length:
            raise RuntimeError(
                f"REVIEW_OTP must be exactly {settings.otp_length} digits, to "
                "match OTP_LENGTH. Anything else can never be entered."
            )
        log.warning(
            "REVIEW SIGN-IN IS ENABLED for %s -- fixed code, no SMS. "
            "Clear REVIEW_PHONE and REVIEW_OTP once Play review is done.",
            settings.review_phone.strip(),
        )

    yield
    get_pool().close()


app = FastAPI(
    title="Crop Analytics API",
    version="1.0.0",
    summary="Sugarcane plot boundaries and crop-condition layers for farmers.",
    lifespan=lifespan,
)

# The web app, the Android app and any future client all call this API from a
# different origin, so CORS is configured rather than assumed.
_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origin_list,
    # Matched in addition to the list above. Empty in production, where the exact
    # list is the whole point. A rejected origin makes the browser's preflight
    # fail, which surfaces as an unexplained network error rather than an HTTP
    # status, so it is worth getting right.
    allow_origin_regex=_settings.cors_origin_regex or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(farmer.router)
app.include_router(unit.router)
app.include_router(admin.router)


@app.get("/health", tags=["meta"])
def health() -> dict:
    """Liveness probe for load balancers and deploy scripts."""
    return {"status": "ok"}
