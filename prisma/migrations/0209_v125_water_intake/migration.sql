-- v1.25 — hydration logging.
--
-- Two additive changes, no backfill, no existing row touched:
--
--   1. `WATER_INTAKE` — a new MeasurementType: a manual water-intake counter in
--      millilitres (ml). Cumulative within a day like ACTIVITY_STEPS — each
--      entry adds to the day's running total, summed for the goal ring.
--      DISTINCT from TOTAL_BODY_WATER (a scale body-composition reading in kg).
--      Forward-only: Postgres cannot remove an enum value; idempotent via
--      `IF NOT EXISTS`, so reruns are safe.
--
--   2. `users.hydration_goal_ml` — a nullable per-user daily hydration goal in
--      millilitres. Null means the in-code default (2000 ml). Edited inline on
--      the hydration card.
--
-- The enum value is only added, never used in this same statement batch, so the
-- Postgres "unsafe use of new enum value" restriction does not apply.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WATER_INTAKE';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hydration_goal_ml" INTEGER;
