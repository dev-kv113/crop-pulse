-- Read-only admins.
--
-- A fourth kind of sign-in. Where a unit head oversees one unit, a viewer sees
-- every unit — the same farmer lists, the same plots as the farmer sees them,
-- the same monitoring dashboards — and can change none of it. No uploads, no
-- renames, no logins granted. It is the role for someone who needs the whole
-- picture without the ability to disturb it.
--
-- A table rather than a setting, so the super admin grants and revokes it in the
-- app the way they already do for unit heads. The chicken-and-egg argument that
-- keeps super admins in ADMIN_PHONES does not apply here: a viewer is always
-- created by a super admin who already exists.
CREATE TABLE viewers (
    id         BIGSERIAL PRIMARY KEY,
    -- E.164, unique: one number signs in as one person.
    phone      TEXT   NOT NULL UNIQUE,
    name       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
