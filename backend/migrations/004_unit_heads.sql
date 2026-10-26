-- Unit heads.
--
-- A third kind of sign-in, between admin and farmer: someone responsible for one
-- unit, who can look up any farmer in that unit and see exactly what that farmer
-- sees, but cannot upload data or reach another unit.
--
-- Admins stay in the ADMIN_PHONES setting rather than a table, so there is never
-- a chicken-and-egg problem creating the first one. Unit heads cannot work that
-- way because each needs to be tied to a specific unit, so they live here.

CREATE TABLE unit_heads (
    id         BIGSERIAL PRIMARY KEY,
    -- E.164, and unique across all unit heads: one number signs in as one
    -- person, in one unit.
    phone      TEXT   NOT NULL UNIQUE,
    name       TEXT,
    unit_id    BIGINT NOT NULL REFERENCES units (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX unit_heads_unit_idx ON unit_heads (unit_id);
