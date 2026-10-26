-- Crop Pulse initial schema.
--
-- Two kinds of data live here:
--   1. The plot register  - who farms which piece of land (uploaded once, rarely changes).
--   2. Analysis layers    - one uploaded GeoJSON per survey date, showing crop
--                           condition classes across the whole region.
--
-- The analysis GeoJSON has no plot id in it: it is a wall-to-wall raster that
-- has been vectorised, so it covers farms, roads and rivers alike. To show a
-- farmer only their own land we intersect it with each plot ONCE at upload time
-- and store the result in `plot_analysis`. Serving a farmer is then a plain
-- indexed lookup instead of a spatial join.

CREATE EXTENSION IF NOT EXISTS postgis;


-- ---------------------------------------------------------------- people ----

-- One row per FARM_CODE in the plot layer. A farmer may hold several plots.
CREATE TABLE farmers (
    id         BIGSERIAL PRIMARY KEY,
    farm_code  TEXT        NOT NULL UNIQUE,
    name       TEXT,
    -- E.164 (e.g. +919876543210). Null until we learn the farmer's number,
    -- because the plot layer does not always carry one.
    phone      TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admins are configured by phone number in the ADMIN_PHONES setting rather than
-- stored here, so there is no chicken-and-egg problem creating the first one.


-- ----------------------------------------------------------------- plots ----

CREATE TABLE plots (
    id             BIGSERIAL PRIMARY KEY,
    -- UNIQ_ID from the source file. Lets a re-upload update rather than duplicate.
    uniq_id        TEXT   NOT NULL UNIQUE,
    farmer_id      BIGINT NOT NULL REFERENCES farmers (id) ON DELETE CASCADE,

    -- The handful of attributes the app actually displays, lifted out of the
    -- source properties so queries stay readable.
    village        TEXT,
    area_name      TEXT,
    zone           TEXT,
    variety        TEXT,
    survey_date    DATE,
    -- The source file's Survey_Are column is in ACRES, not hectares: across all
    -- 42k plots it correlates with the true polygon area at 0.9986 once
    -- converted. We keep the surveyed figure as given (farmers here talk in
    -- acres) and store the hectare equivalent beside it, so the plot area and
    -- the analysis breakdown can be compared in the same unit.
    survey_area_acres DOUBLE PRECISION,
    survey_area_ha    DOUBLE PRECISION,

    -- Everything else from the source feature, kept verbatim. Nothing is lost on
    -- import, and new source columns need no migration to be stored.
    attributes     JSONB NOT NULL DEFAULT '{}'::jsonb,

    geom           geometry(MultiPolygon, 4326) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX plots_geom_idx   ON plots USING GIST (geom);
CREATE INDEX plots_farmer_idx ON plots (farmer_id);


-- -------------------------------------------------------- analysis layers ---

-- One row per uploaded analysis GeoJSON, i.e. one survey date.
CREATE TABLE analysis_layers (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    capture_date  DATE NOT NULL,
    description   TEXT,

    -- pending -> processing -> ready, or failed. Farmers only ever see 'ready'
    -- layers that are also published, so a half-imported file is never visible.
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
    error         TEXT,
    is_published  BOOLEAN NOT NULL DEFAULT FALSE,

    source_filename TEXT,
    source_srid     INTEGER,          -- CRS declared by the uploaded file
    feature_count   INTEGER NOT NULL DEFAULT 0,   -- polygons in the source file
    clipped_count   INTEGER NOT NULL DEFAULT 0,   -- rows produced in plot_analysis

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at  TIMESTAMPTZ
);

CREATE INDEX analysis_layers_visible_idx
    ON analysis_layers (capture_date DESC)
    WHERE status = 'ready' AND is_published;


-- The legend, stored per layer so a future upload may use a different set of
-- classes without breaking older layers.
CREATE TABLE analysis_classes (
    layer_id   BIGINT NOT NULL REFERENCES analysis_layers (id) ON DELETE CASCADE,
    class_id   INTEGER NOT NULL,
    class_name TEXT   NOT NULL,   -- verbatim from the file
    label      TEXT   NOT NULL,   -- short human-friendly name shown in the legend
    color      TEXT   NOT NULL,   -- '#rrggbb'
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (layer_id, class_id)
);


-- Raw uploaded polygons, reprojected to WGS84. Kept after clipping so that a
-- later plot upload can be clipped against existing layers without re-uploading
-- the file, and so other tools can consume the untouched layer.
CREATE TABLE analysis_features (
    id       BIGSERIAL PRIMARY KEY,
    layer_id BIGINT  NOT NULL REFERENCES analysis_layers (id) ON DELETE CASCADE,
    class_id INTEGER NOT NULL,
    geom     geometry(MultiPolygon, 4326) NOT NULL
);

CREATE INDEX analysis_features_geom_idx  ON analysis_features USING GIST (geom);
CREATE INDEX analysis_features_layer_idx ON analysis_features (layer_id);


-- The derived table the farmer API actually reads: analysis polygons cut to the
-- boundary of a single plot, dissolved so there is one row per (plot, class).
CREATE TABLE plot_analysis (
    id       BIGSERIAL PRIMARY KEY,
    layer_id BIGINT  NOT NULL REFERENCES analysis_layers (id) ON DELETE CASCADE,
    plot_id  BIGINT  NOT NULL REFERENCES plots (id)           ON DELETE CASCADE,
    class_id INTEGER NOT NULL,
    area_ha  DOUBLE PRECISION NOT NULL,
    geom     geometry(MultiPolygon, 4326) NOT NULL,
    UNIQUE (layer_id, plot_id, class_id)
);

CREATE INDEX plot_analysis_lookup_idx ON plot_analysis (plot_id, layer_id);


-- ------------------------------------------------------------------- OTP ----

-- Codes are stored hashed, so a database leak does not hand out live codes.
CREATE TABLE otp_codes (
    id         BIGSERIAL PRIMARY KEY,
    phone      TEXT        NOT NULL,
    code_hash  TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    attempts   INTEGER     NOT NULL DEFAULT 0,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX otp_codes_lookup_idx ON otp_codes (phone, created_at DESC);
