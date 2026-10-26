"""Application settings, read once from the environment.

Three places are consulted, in this order of priority:

  1. real environment variables      (what docker-compose sets)
  2. backend/.env                    (the file next to this app)
  3. a secrets directory             (one file per setting, named after it)

The third exists so a genuine secret -- the SMS auth key, the signing secret --
can live outside the repository entirely, on a path only the person running the
server can read. A file called `msg91_auth_key` there holds nothing but the key.
Because it is the lowest priority, putting the same setting in `.env` still
overrides it, which is what you want while debugging.
"""

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Inside the container this is where the host directory is mounted; set
# SECRETS_DIR to point somewhere else when running the API directly on a
# machine. Left unset when the directory is absent, because naming a directory
# that does not exist makes pydantic warn on every start.
_SECRETS_DIR = os.getenv("SECRETS_DIR", "/run/secrets")
_secrets_dir = _SECRETS_DIR if Path(_SECRETS_DIR).is_dir() else None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", secrets_dir=_secrets_dir, extra="ignore"
    )

    # Database
    database_url: str = "postgresql://croppulse:croppulse@localhost:5433/croppulse"
    # How many PostgreSQL connections this API process may hold open. Each one
    # serves a request at a time, so this is the ceiling on concurrent database
    # work per process -- not on users, since a request lasts a few
    # milliseconds. Raise it with traffic, but keep
    #   (instances x db_pool_max) < the server's max_connections (default 100).
    db_pool_min: int = 1
    db_pool_max: int = 10

    # Auth
    jwt_secret: str = "dev-secret-change-me"
    # How long a staff session lasts: admin, read-only admin, unit head.
    # Bounded on purpose -- see `_expiry_hours` in security.py.
    jwt_expiry_hours: int = 720
    # How long a farmer stays signed in. Ten years, i.e. "until they sign out",
    # which is how a phone app is expected to behave.
    farmer_jwt_expiry_hours: int = 87_600
    admin_phones: str = ""

    # OTP
    sms_provider: str = "console"

    # MSG91, read only when SMS_PROVIDER=msg91.
    #
    # The auth key is the one secret here and has no default on purpose: an
    # empty one must fail loudly at startup, not send nothing quietly.
    msg91_auth_key: str = ""
    # The DLT-registered header. Six characters, approved with the template.
    msg91_sender_id: str = "GEOTRN"
    # MSG91's own id for the flow, from their panel: 24 hex characters.
    # Not the DLT template id, which is a 19-digit number registered with
    # SmartPing -- MSG91 stores that against the flow and sends it onward, so
    # this app never needs it. The two are easy to mix up and only one works.
    msg91_template_id: str = ""
    # The variable in that template that carries the code. Must match the name
    # in the MSG91 flow exactly, or the message goes out with an empty code.
    msg91_otp_var: str = "OTP"
    # A farmer is staring at a "sending code" spinner while this runs, so it
    # fails rather than hangs.
    msg91_timeout_seconds: float = 10.0
    msg91_url: str = "https://control.msg91.com/api/v5/flow"
    otp_length: int = 6
    otp_ttl_seconds: int = 300
    otp_max_attempts: int = 5

    # A single number whose code is fixed rather than random, and never sent by
    # SMS. It exists for one reason: Google Play will not approve an app behind
    # a sign-in without giving reviewers a way in, and a reviewer outside India
    # cannot receive an Indian OTP.
    #
    # Both blank means the feature does not exist -- there is no default number
    # and no default code, so it cannot be left on by accident. The number must
    # ALSO be enrolled normally (as a farmer, or a read-only admin) or there is
    # nothing for it to sign in as; this only replaces how its code is made and
    # delivered, never who it turns out to be.
    #
    # Treat the pair as a password: anyone who learns both can sign in as that
    # account. Point it at a demo account, and clear it once review is done.
    review_phone: str = ""
    review_otp: str = ""

    # Files
    upload_dir: str = "./var/uploads"

    # CORS
    cors_origins: str = "http://localhost:5174"
    # An optional pattern matched against the browser's Origin, on top of the
    # exact list above. Development needs it because the dev server is also
    # reachable on your machine's LAN address, so you can open the app on a
    # phone -- and that address changes whenever you join a different network,
    # which makes an exact list useless. LEAVE THIS EMPTY IN PRODUCTION, where
    # naming the allowed origins exactly is the entire point.
    cors_origin_regex: str = ""

    @property
    def admin_phone_list(self) -> list[str]:
        return [p.strip() for p in self.admin_phones.split(",") if p.strip()]

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def expose_otp_in_response(self) -> bool:
        """True only for the console provider, which has no way to deliver a code."""
        return self.sms_provider == "console"


@lru_cache
def get_settings() -> Settings:
    return Settings()
