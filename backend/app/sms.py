"""OTP delivery.

Everything that sends an SMS goes through `SmsProvider`, so adding a real
gateway later means writing one small class and changing the SMS_PROVIDER
setting -- no route or auth code changes.

Note for India: sending transactional SMS to Indian numbers requires TRAI DLT
registration of the sender id and the message template. That is a commercial
signup, not a code change, which is exactly why the console provider exists --
the whole app can be built and tested before that paperwork is done.

Whichever provider is active, this app owns the code: it generates it, stores it
hashed, and verifies it. A provider only delivers.
"""

import logging
from abc import ABC, abstractmethod

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)


class SmsDeliveryError(RuntimeError):
    """The gateway did not accept the message.

    Separate from a configuration error: this one means the code was generated
    and stored but never reached the phone, so the caller must tell the user to
    try again rather than leave them waiting for an SMS that is not coming.
    """


class SmsProvider(ABC):
    """Sends a one-time code to a phone number."""

    @abstractmethod
    def send_otp(self, phone: str, code: str) -> None: ...


class ConsoleSmsProvider(SmsProvider):
    """Development provider: writes the code to the log instead of sending it.

    The API also returns the code in the response body while this provider is
    active (see `Settings.expose_otp_in_response`), so you can log in locally
    without any SMS gateway.
    """

    def send_otp(self, phone: str, code: str) -> None:
        log.warning("[console-sms] OTP for %s is %s", phone, code)


class Msg91SmsProvider(SmsProvider):
    """Delivers the code through MSG91's Flow API.

    **Flow, not MSG91's own OTP API, on purpose.** This app generates, stores
    and verifies its own codes (`security.issue_otp` and `verify_otp`), so the
    gateway's only job is delivery. MSG91's OTP endpoint would generate and
    verify a code of its own, leaving two systems each believing they own the
    one the farmer is typing. Flow just fills a variable into an approved
    template and sends it, which is exactly the job.

    The template is the DLT-registered one, referenced by id. Its text is not
    repeated here: TRAI requires the delivered message to match what was
    approved, so a copy in this file would be a second version of the truth,
    free to drift and impossible to send.
    """

    def __init__(self) -> None:
        settings = get_settings()
        missing = [
            name
            for name, value in (
                ("MSG91_AUTH_KEY", settings.msg91_auth_key),
                ("MSG91_TEMPLATE_ID", settings.msg91_template_id),
                ("MSG91_SENDER_ID", settings.msg91_sender_id),
            )
            if not str(value).strip()
        ]
        if missing:
            raise RuntimeError(
                f"SMS_PROVIDER=msg91 needs {', '.join(missing)} set in the "
                "environment. Refusing to start rather than accept logins that "
                "can never deliver a code."
            )
        self._settings = settings

    def send_otp(self, phone: str, code: str) -> None:
        settings = self._settings
        payload = {
            "template_id": settings.msg91_template_id,
            "sender": settings.msg91_sender_id,
            # Link shortening rewrites URLs and would break a DLT-approved body.
            "short_url": "0",
            # MSG91 wants country code + number and no "+": 919876543210. Our
            # numbers are stored E.164, so the plus is the only difference.
            "recipients": [
                {"mobiles": phone.lstrip("+"), settings.msg91_otp_var: code}
            ],
        }

        try:
            response = httpx.post(
                settings.msg91_url,
                headers={
                    "authkey": settings.msg91_auth_key,
                    "accept": "application/json",
                },
                json=payload,
                timeout=settings.msg91_timeout_seconds,
            )
        except httpx.HTTPError as exc:
            # Network, DNS or timeout: nothing was delivered.
            raise SmsDeliveryError(f"Could not reach MSG91: {exc}") from exc

        try:
            body = response.json()
        except ValueError:
            body = {}

        # MSG91 answers 200 with {"type": "error"} for a rejected send -- a
        # wrong template id or an unapproved sender both look like success if
        # you only read the status code.
        rejected = response.status_code >= 400 or (
            str(body.get("type", "")).lower() == "error"
        )
        if rejected:
            detail = body.get("message") or response.text[:200]
            raise SmsDeliveryError(
                f"MSG91 rejected the message (HTTP {response.status_code}): {detail}"
            )

        # The code itself is never logged here, unlike in development: these
        # lines go to a real log that real people can read.
        log.info(
            "OTP delivered to %s via MSG91 (request %s)",
            phone,
            body.get("request_id", "-"),
        )


_PROVIDERS: dict[str, type[SmsProvider]] = {
    "console": ConsoleSmsProvider,
    "msg91": Msg91SmsProvider,
}


def get_sms_provider() -> SmsProvider:
    name = get_settings().sms_provider
    try:
        return _PROVIDERS[name]()
    except KeyError:
        raise RuntimeError(
            f"Unknown SMS_PROVIDER {name!r}. Known providers: {sorted(_PROVIDERS)}"
        ) from None
