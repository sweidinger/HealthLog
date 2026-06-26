-- v1.21.0 — rebase the regression accumulators to a fixed recent x-origin.
--
-- Migration 0190 stored the OLS accumulators `sum_x / sum_xy / sum_xx` over a
-- RAW epoch-day x-axis (`EXTRACT(EPOCH FROM measured_at) / 86400.0`). Raw
-- epoch-days sit at x ≈ 20 540, so `x²` lands near 4.2e8 and the per-bucket
-- `SUM(x²)` accumulates past ~1e10. A double carries ~15-16 significant decimal
-- digits; a value ~1e10 has ~10 integer digits, leaving only ~5-6 fractional
-- digits — so the SUB-DAY x detail (the time-of-day fraction) is already lost
-- when `sum_xx` is squared and summed, BEFORE the value is ever stored. No
-- read-side identity (mean-centering included) can recover bits lost at
-- accumulation time. That precision floor is why the windowed slope / r² on a
-- near-flat, ill-conditioned window drifted from the live REGR_* probe past the
-- 1e-9 parity gauge (the rollup-regression-parity DST case).
--
-- The fix is a WINDOW-LOCAL X-RESCALE: accumulate x RELATIVE to a fixed origin
-- so the squared terms stay small and exact. The origin is 2020-01-01
-- (epoch-day 18262); rebased x = epoch_days − 18262 stays in the low thousands
-- for any realistic reading, so `x²` ≤ ~1e7 and `sum_xx` never sheds precision.
--
--   sum_x'  = Σ (epoch_days − 18262)
--   sum_xy' = Σ (epoch_days − 18262) · value
--   sum_xx' = Σ (epoch_days − 18262)²
--
-- Slope / r² / population-sd are INVARIANT under an affine x-shift (Sxx, Sxy,
-- Syy are unchanged when a constant is subtracted from every x), so the
-- cross-bucket compose yields the SAME regression as before — only the
-- unreported intercept would move. The live REGR_* probe stays on raw
-- epoch-days and still parity-matches because it, too, is shift-invariant.
-- `sum_yy / sum_value / count / mean / sd / slope / r2` are y-only or
-- shift-invariant and are NOT touched.
--
-- This recomputes the three rebased accumulators DIRECTLY FROM `measurements`,
-- grouped exactly as the writer groups (per user / type / granularity-bucket /
-- source over non-deleted rows). Recompute-from-source makes the migration
-- naturally IDEMPOTENT and self-correcting: a rerun re-derives the same rebased
-- sums regardless of the column's prior state (raw 0190 basis, partially
-- rebased, or already rebased). It only writes rows that already carry the 0190
-- accumulators (`sum_xy IS NOT NULL`), so NULL pre-migration rows stay NULL for
-- the boot re-fold to fill on the new basis. Set-based, one statement per
-- granularity; the `(user_id, type, measured_at)` index bounds the scan.
--
-- Reversibility (down): re-fold the accumulators on the raw epoch-day basis,
-- i.e. drop the `− 18262` from each SUM. There is no column shape change to
-- revert; the legacy basis is recoverable by re-running 0190's populator.

-- DAY buckets.
UPDATE "measurement_rollups" r
SET "sum_x"  = s."sum_x",
    "sum_xy" = s."sum_xy",
    "sum_xx" = s."sum_xx"
FROM (
  SELECT
    m."user_id" AS user_id,
    m."type"    AS type,
    date_trunc('day', m."measured_at") AS bucket_start,
    m."source"  AS source,
    SUM(EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262) AS sum_x,
    SUM((EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262) * m."value") AS sum_xy,
    SUM((EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262)
        * (EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262)) AS sum_xx
  FROM measurements m
  WHERE m."deleted_at" IS NULL
  GROUP BY m."user_id", m."type", date_trunc('day', m."measured_at"), m."source"
) s
WHERE r."granularity" = 'DAY'
  AND r."sum_xy" IS NOT NULL
  AND r."user_id"      = s.user_id
  AND r."type"         = s.type
  AND r."bucket_start" = s.bucket_start
  AND r."source"       = s.source;

-- WEEK buckets.
UPDATE "measurement_rollups" r
SET "sum_x"  = s."sum_x",
    "sum_xy" = s."sum_xy",
    "sum_xx" = s."sum_xx"
FROM (
  SELECT
    m."user_id" AS user_id,
    m."type"    AS type,
    date_trunc('week', m."measured_at") AS bucket_start,
    m."source"  AS source,
    SUM(EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262) AS sum_x,
    SUM((EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262) * m."value") AS sum_xy,
    SUM((EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262)
        * (EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262)) AS sum_xx
  FROM measurements m
  WHERE m."deleted_at" IS NULL
  GROUP BY m."user_id", m."type", date_trunc('week', m."measured_at"), m."source"
) s
WHERE r."granularity" = 'WEEK'
  AND r."sum_xy" IS NOT NULL
  AND r."user_id"      = s.user_id
  AND r."type"         = s.type
  AND r."bucket_start" = s.bucket_start
  AND r."source"       = s.source;

-- MONTH buckets.
UPDATE "measurement_rollups" r
SET "sum_x"  = s."sum_x",
    "sum_xy" = s."sum_xy",
    "sum_xx" = s."sum_xx"
FROM (
  SELECT
    m."user_id" AS user_id,
    m."type"    AS type,
    date_trunc('month', m."measured_at") AS bucket_start,
    m."source"  AS source,
    SUM(EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262) AS sum_x,
    SUM((EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262) * m."value") AS sum_xy,
    SUM((EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262)
        * (EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262)) AS sum_xx
  FROM measurements m
  WHERE m."deleted_at" IS NULL
  GROUP BY m."user_id", m."type", date_trunc('month', m."measured_at"), m."source"
) s
WHERE r."granularity" = 'MONTH'
  AND r."sum_xy" IS NOT NULL
  AND r."user_id"      = s.user_id
  AND r."type"         = s.type
  AND r."bucket_start" = s.bucket_start
  AND r."source"       = s.source;

-- YEAR buckets.
UPDATE "measurement_rollups" r
SET "sum_x"  = s."sum_x",
    "sum_xy" = s."sum_xy",
    "sum_xx" = s."sum_xx"
FROM (
  SELECT
    m."user_id" AS user_id,
    m."type"    AS type,
    date_trunc('year', m."measured_at") AS bucket_start,
    m."source"  AS source,
    SUM(EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262) AS sum_x,
    SUM((EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262) * m."value") AS sum_xy,
    SUM((EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262)
        * (EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262)) AS sum_xx
  FROM measurements m
  WHERE m."deleted_at" IS NULL
  GROUP BY m."user_id", m."type", date_trunc('year', m."measured_at"), m."source"
) s
WHERE r."granularity" = 'YEAR'
  AND r."sum_xy" IS NOT NULL
  AND r."user_id"      = s.user_id
  AND r."type"         = s.type
  AND r."bucket_start" = s.bucket_start
  AND r."source"       = s.source;
