-- v1.12.8 — WHOOP cycle + sleep coverage completion (additive).
--
-- Purely-additive: three new `measurement_type` enum members for WHOOP fields
-- a coverage audit found were read-and-dropped (cycle average / max heart
-- rate) or never fetched (per-night sleep disturbance count). No backfill, no
-- existing row touched.
--
--   AVERAGE_HEART_RATE / MAX_HEART_RATE land the WHOOP `cycle.score`
--   average_heart_rate / max_heart_rate (previously typed but never emitted by
--   `mapCycle`). They stay distinct from spot PULSE, RESTING_HEART_RATE, and
--   WALKING_HEART_RATE_AVERAGE — these are the day's whole-cycle aggregates.
--
--   SLEEP_DISTURBANCE_COUNT lands the WHOOP `sleep.score.stage_summary`
--   disturbance_count (per-night tally).
--
-- Postgres enum-add is non-transactional; the `IF NOT EXISTS` guards make a
-- rerun safe. Forward-only — Postgres cannot remove an enum value, so the
-- three new members stay; with no rows carrying them they are inert.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'AVERAGE_HEART_RATE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'MAX_HEART_RATE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'SLEEP_DISTURBANCE_COUNT';
