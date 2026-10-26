-- Units.
--
-- The mill is organised into units, and data arrives one unit at a time: a plot
-- register per unit, then an analysis GeoJSON per unit per survey date. Making
-- that structure explicit means a re-upload for one unit cannot disturb another,
-- and clipping only has to consider the plots that belong to the same unit.
--
-- Eight units are seeded so the app can be demonstrated end to end. Rename them
-- to the real unit names when you have them - nothing references the name.

CREATE TABLE units (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO units (name, sort_order)
SELECT 'Unit ' || n, n FROM generate_series(1, 8) AS n;


-- Every plot and every analysis layer belongs to a unit.
ALTER TABLE plots           ADD COLUMN unit_id BIGINT REFERENCES units (id);
ALTER TABLE analysis_layers ADD COLUMN unit_id BIGINT REFERENCES units (id);

-- The true area of the boundary, computed from its coordinates rather than
-- taken from the survey record. `geography` makes ST_Area return square metres
-- on the ellipsoid, so this is a real ground area, not a degrees-squared number.
ALTER TABLE plots ADD COLUMN computed_area_ha DOUBLE PRECISION;

-- Anything already loaded came from the first unit's files.
UPDATE plots           SET unit_id = (SELECT id FROM units WHERE name = 'Unit 1')
                       WHERE unit_id IS NULL;
UPDATE analysis_layers SET unit_id = (SELECT id FROM units WHERE name = 'Unit 1')
                       WHERE unit_id IS NULL;
UPDATE plots SET computed_area_ha = ST_Area(geom::geography) / 10000.0
             WHERE computed_area_ha IS NULL;

CREATE INDEX plots_unit_idx           ON plots (unit_id);
CREATE INDEX analysis_layers_unit_idx ON analysis_layers (unit_id);
