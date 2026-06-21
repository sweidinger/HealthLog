-- v1.19.2 (iOS #34 extension) — per-bucket heart-rate spread.
--
-- v1.19.0 shipped the hourly heart-rate bucket
-- (`stats:HKQuantityTypeIdentifierHeartRate:<UTC-hour>`) carrying the
-- hour's AVERAGE bpm as one PULSE row. This adds the hour's MIN / MAX bpm
-- as two companion columns so a client can render the intra-hour range
-- (low/high band around the mean) without iOS re-uploading raw samples.
--
-- Two additive, nullable columns on `measurements`:
--
--   * `value_min` — the bucket's minimum bpm.
--   * `value_max` — the bucket's maximum bpm.
--
-- Set ONLY on the hourly heart-rate bucket rows; NULL for every other row
-- (per-sample readings, per-day cumulative `stats:` totals, manual
-- entries). The series reader hands them through only for the heart-rate
-- kind, and the batch ingest persists / overwrites them alongside `value`.
--
-- Additive; no existing row touched. The columns default to NULL so every
-- legacy row and every non-HR-bucket write stays unchanged. Idempotent
-- guards (`ADD COLUMN IF NOT EXISTS`) so a rerun is safe on prod.
--
-- Reversibility (down):
--   ALTER TABLE "measurements" DROP COLUMN IF EXISTS "value_min";
--   ALTER TABLE "measurements" DROP COLUMN IF EXISTS "value_max";
-- The columns are read-additive — dropping them reverts to the avg-only
-- v1.19.0 contract.

ALTER TABLE "measurements"
    ADD COLUMN IF NOT EXISTS "value_min" DOUBLE PRECISION;

ALTER TABLE "measurements"
    ADD COLUMN IF NOT EXISTS "value_max" DOUBLE PRECISION;
