-- v1.17.1 — Oura coverage completion (additive).
--
-- Two new `measurement_type` enum values so the Oura sync can store signals it
-- already fetches (or now fetches) but had no home for:
--
--   1. `SLEEP_SCORE` — Oura's headline 0–100 Sleep Score from the
--      `daily_sleep` collection (distinct from the per-stage `sleep` detail).
--      Kept apart from the WHOOP `SLEEP_PERFORMANCE` / `SLEEP_EFFICIENCY`
--      sub-scores so two vendors' headline numbers never share a bucket.
--   2. `BODY_TEMPERATURE_DEVIATION` — Oura's nightly body-temperature deviation
--      from the user's personal baseline (`daily_readiness.temperature_deviation`),
--      a SIGNED °C offset (illness / luteal-phase / stress signal). It is NOT an
--      absolute reading, so it cannot share the BODY_TEMPERATURE /
--      SKIN_TEMPERATURE / WRIST_TEMPERATURE absolute-temperature buckets.
--
-- Purely-additive: two enum extensions, no backfill, no existing row touched,
-- no new tables or columns. Both stored as `source = OURA`.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'SLEEP_SCORE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'BODY_TEMPERATURE_DEVIATION';
