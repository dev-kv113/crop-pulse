-- The legend gained a second line showing the class's numeric density band
-- (e.g. "0.33 - 0.42"), parsed from the source class name at import time.
ALTER TABLE analysis_classes ADD COLUMN IF NOT EXISTS detail TEXT;
