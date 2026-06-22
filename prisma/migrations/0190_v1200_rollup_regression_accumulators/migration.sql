-- v1.20.0 F6 — rollup-tier completion: per-bucket regression accumulators.
--
-- Up to v1.19.x the windowed slope / r² / sd (slope7/30/90, r²_7/30/90,
-- the 90-day population stddev) still ran as a live `$queryRaw` over the
-- raw `measurements` partition on EVERY warm-rollup request, because the
-- per-bucket `mean` cannot reconstruct an OLS regression over the raw
-- points in a window. The per-bucket `sd / slope / r2` columns are a
-- within-bucket fold and are NOT linearly composable across DAY buckets.
--
-- This adds the four regression-accumulator sums Postgres' REGR_* /
-- STDDEV_POP folds expose, computed per (user, type, granularity,
-- bucketStart, source) over the same canonical-source rows the live
-- query reads. With `n = count` and `Σy = mean·count` already stored,
-- these four close the set: all six terms are ADDITIVE across buckets,
-- so a 7/30/90-day slope / r² / sd composes from the summed accumulators
-- with a bit-identical result to the live REGR_SLOPE / REGR_R2 /
-- STDDEV_POP over the raw rows (Postgres uses the same closed form):
--
--   slope  = (n·Σxy − Σx·Σy) / (n·Σxx − Σx²)
--   r²     = (n·Σxy − Σx·Σy)² / ((n·Σxx − Σx²)(n·Σyy − Σy²))
--   sd_pop = sqrt(Σyy/n − (Σy/n)²)
--
-- The x-axis is EPOCH DAYS (`EXTRACT(EPOCH FROM measured_at) / 86400.0`),
-- matching the live REGR_* calls in `measurement-rollups.ts`,
-- `summaries-slice.ts`, and `comprehensive-aggregator.ts`. The raw
-- (un-rebased) epoch-day sums are stored so the cross-bucket sum
-- reconstructs the same regression the live query runs.
--
-- Four additive, nullable `DOUBLE PRECISION` columns on
-- `measurement_rollups`:
--
--   * `sum_x`  — Σ epoch_days
--   * `sum_xy` — Σ (epoch_days · value)
--   * `sum_xx` — Σ epoch_days²
--   * `sum_yy` — Σ value²
--
-- Nullable keeps the migration additive: existing rows read NULL until
-- the boot-time `rollup-full-backfill` re-fold refills them (mirrors the
-- v1.4.39 `sum_value` rollout). New writes self-populate because the
-- accumulators ride the same aggregate that already recomputes on every
-- write hook. The legacy per-bucket `sd / slope / r2` columns are left
-- in place (harmless) to keep this migration purely additive.
--
-- Additive; no existing row touched. Idempotent guards
-- (`ADD COLUMN IF NOT EXISTS`) so a rerun is safe on prod.
--
-- Reversibility (down):
--   ALTER TABLE "measurement_rollups" DROP COLUMN IF EXISTS "sum_x";
--   ALTER TABLE "measurement_rollups" DROP COLUMN IF EXISTS "sum_xy";
--   ALTER TABLE "measurement_rollups" DROP COLUMN IF EXISTS "sum_xx";
--   ALTER TABLE "measurement_rollups" DROP COLUMN IF EXISTS "sum_yy";
-- Dropping them reverts the readers to the live REGR_* path on a
-- coverage miss; the read-swap falls back automatically when the
-- accumulators are NULL.

ALTER TABLE "measurement_rollups"
    ADD COLUMN IF NOT EXISTS "sum_x" DOUBLE PRECISION;

ALTER TABLE "measurement_rollups"
    ADD COLUMN IF NOT EXISTS "sum_xy" DOUBLE PRECISION;

ALTER TABLE "measurement_rollups"
    ADD COLUMN IF NOT EXISTS "sum_xx" DOUBLE PRECISION;

ALTER TABLE "measurement_rollups"
    ADD COLUMN IF NOT EXISTS "sum_yy" DOUBLE PRECISION;
