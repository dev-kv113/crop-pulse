-- The monitoring dashboard code for a unit.
--
-- Crop condition monitoring lives in a separate Streamlit app, which picks the
-- mill from its own URL: analytics.geotranstech.com/?unit=DEO. That app knows
-- units by a short code, not by the name shown here, and an admin is expected to
-- rename 'Unit 3' to whatever the mill actually calls it. Deriving the code from
-- the name would therefore break the dashboard link the first time somebody
-- renames a unit, so the code is stored on its own and edited on its own.
--
-- Nullable on purpose: a unit with no code simply shows no dashboard, which is
-- the right behaviour for a ninth unit added before its data is published.
ALTER TABLE units ADD COLUMN analytics_code TEXT
    CHECK (analytics_code ~ '^[A-Za-z0-9_-]{1,16}$');

-- The eight codes the dashboard publishes today, matched to the eight seeded
-- units in order. This is a starting point, not a fact: an admin can change any
-- of them, and renaming a unit leaves its code alone.
UPDATE units
   SET analytics_code = seed.code
  FROM (VALUES (1, 'CHP'), (2, 'DEO'), (3, 'KHT'), (4, 'MNP'),
               (5, 'RKL'), (6, 'RNG'), (7, 'SBT'), (8, 'SHM'))
       AS seed (n, code)
 WHERE units.sort_order = seed.n
   AND units.analytics_code IS NULL;
