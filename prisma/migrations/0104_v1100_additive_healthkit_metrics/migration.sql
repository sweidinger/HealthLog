-- v1.10.0 — extend `measurement_type` with seven additive HealthKit
-- signals that previously sat in the deferred set.
--
-- Background: each identifier below was emitted by the iOS client but
-- mapped to no `MeasurementType`, so the batch route ack-200'd a
-- per-entry `skipped:"unmappable_identifier"` and the sample was lost.
-- They are now wired end-to-end (mapping + plausibility range + the
-- generic metric-status assessment surface).
--
--   CARDIO_RECOVERY          ← HKQuantityTypeIdentifierHeartRateRecoveryOneMinute
--   WRIST_TEMPERATURE        ← HKQuantityTypeIdentifierAppleSleepingWristTemperature
--   FALL_COUNT               ← HKQuantityTypeIdentifierNumberOfTimesFallen
--   SIX_MINUTE_WALK_DISTANCE ← HKQuantityTypeIdentifierSixMinuteWalkTestDistance
--   STAIR_ASCENT_SPEED       ← HKQuantityTypeIdentifierStairAscentSpeed
--   STAIR_DESCENT_SPEED      ← HKQuantityTypeIdentifierStairDescentSpeed
--   BREATHING_DISTURBANCES   ← HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances
--
-- Unit convention: every one of these ships raw on the wire and passes
-- through `convertToDbUnit` as identity — none is a 0..1 fraction, so the
-- ×100 percent-scaling path the gait-percent metrics use does NOT apply.
-- The convention block at the top of
-- `src/lib/measurements/apple-health-mapping.ts` spells the split out.
--
-- Pure additive — no existing row carries any of these values. The
-- `IF NOT EXISTS` guard keeps the migration idempotent so the runner can
-- replay it on a partially-applied environment without failing on the
-- duplicate-enum-value error code. Forward-only; enum values cannot be
-- dropped in PostgreSQL, so there is no automatic down path.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'CARDIO_RECOVERY';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WRIST_TEMPERATURE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'FALL_COUNT';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'SIX_MINUTE_WALK_DISTANCE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'STAIR_ASCENT_SPEED';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'STAIR_DESCENT_SPEED';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'BREATHING_DISTURBANCES';
