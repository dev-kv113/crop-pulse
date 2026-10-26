"""Login: request a code, then exchange it for a token.

There are no passwords. A farmer proves they hold the phone number attached to
their farm record, and that is the whole of the login.
"""

import logging

from fastapi import APIRouter, HTTPException, status

from app.config import get_settings
from app.db import cursor
from app.farmers import load_profile
from app.models import (
    LoginResponse,
    UnitContext,
    OtpRequest,
    OtpRequestResponse,
    OtpVerifyRequest,
)
from app.security import (
    ROLE_ADMIN,
    ROLE_FARMER,
    ROLE_UNIT_HEAD,
    ROLE_VIEWER,
    create_token,
    is_review_phone,
    issue_otp,
    normalise_phone,
    verify_otp,
)
from app.sms import SmsDeliveryError, get_sms_provider

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _find_viewer(phone: str) -> dict | None:
    with cursor() as cur:
        cur.execute("SELECT id, name FROM viewers WHERE phone = %s", (phone,))
        return cur.fetchone()


def _find_unit_head(phone: str) -> dict | None:
    with cursor() as cur:
        cur.execute(
            "SELECT h.id, h.name, h.unit_id, u.name AS unit_name "
            "FROM unit_heads h JOIN units u ON u.id = h.unit_id "
            "WHERE h.phone = %s",
            (phone,),
        )
        return cur.fetchone()


@router.post("/request-otp", response_model=OtpRequestResponse)
def request_otp(payload: OtpRequest) -> OtpRequestResponse:
    """Send a one-time code to a phone number.

    The number must already belong to a farmer, or be listed in ADMIN_PHONES.
    We say so plainly rather than silently accepting unknown numbers: farmers
    are enrolled by the mill, so "not registered" is genuinely useful feedback
    and there is no public sign-up to protect against enumeration.
    """
    settings = get_settings()
    phone = normalise_phone(payload.phone)

    known = (
        phone in settings.admin_phone_list
        or _find_viewer(phone) is not None
        or _find_unit_head(phone) is not None
        or load_profile(phone=phone) is not None
    )
    if not known:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "This number is not registered. Please contact your field officer.",
        )

    code = issue_otp(phone)

    # The reviewer's code is fixed and already known to them, and their number
    # is very likely unreachable from an Indian SMS route. Sending would only
    # fail and block the review.
    if is_review_phone(phone):
        log.warning("Review sign-in requested for %s; no SMS sent", phone)
        return OtpRequestResponse(
            phone=phone,
            message=f"A {settings.otp_length}-digit code has been sent to {phone}.",
            dev_otp=None,
        )

    try:
        get_sms_provider().send_otp(phone, code)
    except SmsDeliveryError as exc:
        # The code exists but never left the building. Say so: a farmer waiting
        # for an SMS that is not coming has no way to tell that from a slow one.
        # The stored code is left alone -- it expires on its own, and requesting
        # another one supersedes it.
        log.error("OTP delivery failed for %s: %s", phone, exc)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Could not send the code just now. Please try again in a moment.",
        ) from exc

    return OtpRequestResponse(
        phone=phone,
        message=f"A {settings.otp_length}-digit code has been sent to {phone}.",
        dev_otp=code if settings.expose_otp_in_response else None,
    )


@router.post("/verify-otp", response_model=LoginResponse)
def verify_otp_and_login(payload: OtpVerifyRequest) -> LoginResponse:
    """Check the code and return a bearer token."""
    settings = get_settings()
    phone = normalise_phone(payload.phone)
    verify_otp(phone, payload.code.strip())

    # Order matters: the first match wins. Admin is checked first so that
    # putting your number in ADMIN_PHONES always works, even if it also happens
    # to belong to a farmer record.
    if phone in settings.admin_phone_list:
        return LoginResponse(
            token=create_token(phone=phone, role=ROLE_ADMIN),
            role=ROLE_ADMIN,
        )

    # Before unit head: a number granted the mill-wide view is not also
    # restricted to one unit, and the wider role is the one they were given.
    if _find_viewer(phone) is not None:
        return LoginResponse(
            token=create_token(phone=phone, role=ROLE_VIEWER),
            role=ROLE_VIEWER,
        )

    head = _find_unit_head(phone)
    if head is not None:
        return LoginResponse(
            token=create_token(
                phone=phone, role=ROLE_UNIT_HEAD, unit_id=head["unit_id"]
            ),
            role=ROLE_UNIT_HEAD,
            unit=UnitContext(
                id=head["unit_id"], name=head["unit_name"], head_name=head["name"]
            ),
        )

    farmer = load_profile(phone=phone)
    if farmer is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "This number is not registered."
        )

    return LoginResponse(
        token=create_token(phone=phone, role=ROLE_FARMER, farmer_id=farmer.id),
        role=ROLE_FARMER,
        farmer=farmer,
    )
