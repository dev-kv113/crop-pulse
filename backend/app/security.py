"""Phone/OTP login, JWT issuing, and the route dependencies that read them."""

import hashlib
import hmac
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings
from app.db import cursor

log = logging.getLogger(__name__)

_bearer = HTTPBearer(auto_error=False)

# The four kinds of sign-in.
#
# How a phone number becomes one of these, in this order (see routers/auth.py):
#
#   1. admin      - the number is listed in the ADMIN_PHONES setting.
#                   Deliberately configuration rather than a database row, so
#                   there is no chicken-and-egg problem creating the first one.
#   2. viewer     - the number matches a row in `viewers`. Sees every unit and
#                   changes nothing.
#   3. unit_head  - the number matches a row in `unit_heads`, which ties it to
#                   exactly one unit.
#   4. farmer     - the number matches `farmers.phone`.
#
# First match wins, and a number that matches nothing cannot sign in at all.
ROLE_FARMER = "farmer"
ROLE_UNIT_HEAD = "unit_head"
ROLE_VIEWER = "viewer"
ROLE_ADMIN = "admin"


# ------------------------------------------------------------ phone numbers --

def normalise_phone(raw: str) -> str:
    """Reduce a typed phone number to E.164 so lookups always match.

    Indian 10-digit numbers are assumed when no country code is given, since
    that is who uses this app.
    """
    digits = re.sub(r"[^\d+]", "", raw or "")
    if digits.startswith("+"):
        return digits
    digits = digits.lstrip("0")
    if len(digits) == 10:
        return f"+91{digits}"
    if len(digits) > 10:
        return f"+{digits}"
    raise HTTPException(status.HTTP_400_BAD_REQUEST, "Enter a valid phone number")


# --------------------------------------------------------------------- OTP ---

def _hash_code(phone: str, code: str) -> str:
    """Hash the code with the JWT secret so stored codes are not usable directly."""
    return hmac.new(
        get_settings().jwt_secret.encode(), f"{phone}:{code}".encode(), hashlib.sha256
    ).hexdigest()


def is_review_phone(phone: str) -> bool:
    """Whether this is the Play Store reviewer's number.

    Compared against the normalised form, so the setting may be written any way
    a person would type it. Blank settings never match anything.
    """
    settings = get_settings()
    if not settings.review_phone.strip() or not settings.review_otp.strip():
        return False
    try:
        return phone == normalise_phone(settings.review_phone)
    except HTTPException:
        # A malformed REVIEW_PHONE disables the feature rather than breaking
        # login for everybody else.
        return False


def issue_otp(phone: str) -> str:
    """Generate, store and return a fresh code for this number."""
    settings = get_settings()
    if is_review_phone(phone):
        # Fixed rather than random. Everything after this point -- hashing,
        # expiry, the attempt limit, single use -- is identical, so the review
        # account gets no weaker treatment than anyone else beyond the code
        # being known in advance.
        code = settings.review_otp.strip()
        log.warning("Issuing the fixed review code for %s", phone)
    else:
        code = "".join(
            secrets.choice("0123456789") for _ in range(settings.otp_length)
        )
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=settings.otp_ttl_seconds)

    with cursor() as cur:
        # Any earlier code for this number stops working the moment a new one is
        # requested, so a resend cannot leave two valid codes in circulation.
        cur.execute(
            "UPDATE otp_codes SET consumed_at = now() "
            "WHERE phone = %s AND consumed_at IS NULL",
            (phone,),
        )
        cur.execute(
            "INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES (%s, %s, %s)",
            (phone, _hash_code(phone, code), expires_at),
        )
    return code


def verify_otp(phone: str, code: str) -> None:
    """Raise unless `code` is the live, unexpired code for `phone`."""
    settings = get_settings()
    with cursor() as cur:
        cur.execute(
            "SELECT id, code_hash, expires_at, attempts FROM otp_codes "
            "WHERE phone = %s AND consumed_at IS NULL "
            "ORDER BY created_at DESC LIMIT 1",
            (phone,),
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Request a code before verifying"
            )
        if row["expires_at"] < datetime.now(timezone.utc):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "That code has expired")
        if row["attempts"] >= settings.otp_max_attempts:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many wrong attempts. Request a new code.",
            )

        if not hmac.compare_digest(row["code_hash"], _hash_code(phone, code)):
            cur.execute(
                "UPDATE otp_codes SET attempts = attempts + 1 WHERE id = %s", (row["id"],)
            )
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "That code is not correct")

        # Consume it, so a code can never be replayed.
        cur.execute(
            "UPDATE otp_codes SET consumed_at = now() WHERE id = %s", (row["id"],)
        )


# --------------------------------------------------------------------- JWT ---

def _expiry_hours(role: str) -> int:
    """How long a session lasts, which is not the same question for everyone.

    A farmer signs in once and stays signed in, the way any app on a phone does.
    Making them do it again is not a small ask here: every sign-in costs an SMS
    the mill pays for, and a wait on a rural connection, to protect a view of
    the farmer's own field. The trade is plainly worth it.

    Staff sessions stay bounded, because the same trade comes out the other way.
    An admin token can read every farmer in the mill and change what they see, it
    is far more likely to be left behind on a shared machine, and there is no
    server-side revocation to fall back on -- nothing in the database can retire
    a token that has already been issued, so its own expiry is the only thing
    that ever ends it. Set FARMER_JWT_EXPIRY_HOURS and JWT_EXPIRY_HOURS to the
    same value if you want staff to behave like farmers.
    """
    settings = get_settings()
    return (
        settings.farmer_jwt_expiry_hours
        if role == ROLE_FARMER
        else settings.jwt_expiry_hours
    )


def create_token(
    *,
    phone: str,
    role: str,
    farmer_id: int | None = None,
    unit_id: int | None = None,
) -> str:
    """Issue a signed token.

    `farmer_id` and `unit_id` carry the caller's scope, so routes never take an
    identity from the client. A farmer's token carries their farmer id; a unit
    head's carries their unit id; an admin's carries neither, because an admin
    is not limited to one.
    """
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": phone,
        "role": role,
        "farmer_id": farmer_id,
        "unit_id": unit_id,
        "iat": now,
        "exp": now + timedelta(hours=_expiry_hours(role)),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


class CurrentUser:
    """Who is calling, decoded from the bearer token."""

    def __init__(
        self,
        phone: str,
        role: str,
        farmer_id: int | None = None,
        unit_id: int | None = None,
    ):
        self.phone = phone
        self.role = role
        self.farmer_id = farmer_id
        self.unit_id = unit_id

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_ADMIN

    @property
    def is_viewer(self) -> bool:
        return self.role == ROLE_VIEWER

    @property
    def is_unit_head(self) -> bool:
        return self.role == ROLE_UNIT_HEAD

    @property
    def sees_all_units(self) -> bool:
        """Whether reads may cross unit boundaries.

        The two roles that oversee the whole mill differ in what they may
        *write*, not in what they may read, so every read scope asks this rather
        than naming the roles — which is what stops a new role being added to one
        query and forgotten in another.
        """
        return self.is_admin or self.is_viewer


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> CurrentUser:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to continue")
    try:
        payload = jwt.decode(
            creds.credentials, get_settings().jwt_secret, algorithms=["HS256"]
        )
    except jwt.PyJWTError:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Your session has expired. Sign in again."
        ) from None
    return CurrentUser(
        phone=payload["sub"],
        role=payload["role"],
        farmer_id=payload.get("farmer_id"),
        unit_id=payload.get("unit_id"),
    )


def require_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")
    return user


def require_unit_head(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """A signed-in unit head. Admins and viewers are allowed through as well.

    Everything behind this guard is a read, and both mill-wide roles may read
    any unit, so blocking them here would only force a second set of
    near-identical routes. Anything that *writes* lives behind `require_admin`.
    """
    if not (user.is_unit_head or user.sees_all_units):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Unit access required")
    return user


def require_farmer(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """A signed-in user who is linked to a farmer record.

    Admins are deliberately excluded: they have no plots of their own, and the
    farmer routes are all scoped to `farmer_id`.
    """
    if user.farmer_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "This account is not linked to any plots"
        )
    return user
