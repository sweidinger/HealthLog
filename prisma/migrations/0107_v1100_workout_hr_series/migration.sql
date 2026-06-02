-- v1.10.0 — per-workout heart-rate series (route-independent).
--
-- A companion to `workout_routes` that holds the per-sample HR series
-- WITHOUT requiring GPS geometry. The route table only exists when a
-- workout has a GeoJSON LineString, so an INDOOR session (treadmill,
-- trainer, strength) had nowhere to store its heart-rate samples even
-- though HealthKit ships them. That series feeds the training-strain
-- engine (TRIMP / time-in-HR-zone), so decoupling it from the route is
-- what unblocks indoor strain.
--
-- Shape rationale:
--   * `samples` JSONB — `[{ t: ISO string, hr?: int, speedMs?, power?,
--     cadence? }]`, one entry per recorded sample. Same JSONB decision
--     as `workout_routes.geometry` / `sample_timestamps`: no PostGIS
--     extension dependency on a self-hosted Postgres install, and the
--     blob mirrors HealthKit's per-sample shape directly.
--   * `sample_count` — denormalised `samples.length` so the strain
--     reader + observability can size the series without deserialising
--     the JSONB blob. The application caps the array length on write
--     (MAX_WORKOUT_HR_SAMPLES in src/lib/validations/workout.ts) so the
--     per-workout payload — and the largest new workout-side write
--     stream — stays bounded.
--
-- 1:1 with the workout: `workout_id` is UNIQUE with an ON DELETE CASCADE
-- FK, exactly like `workout_routes`. A re-submitted batch that wins the
-- workout-row race but loses the sample-row race is an idempotent no-op
-- (the ingest path uses `skipDuplicates`), not a hard error.
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe. Forward-only.
--
-- Reversibility:
--   DROP TABLE IF EXISTS "workout_samples";
-- A roll-back loses the captured per-workout HR series; the workout row,
-- its aggregates (avg/max/min HR), and the route survive untouched.

CREATE TABLE IF NOT EXISTS "workout_samples" (
  "id"           TEXT PRIMARY KEY,
  "workout_id"   TEXT NOT NULL UNIQUE REFERENCES "workouts"("id") ON DELETE CASCADE,
  -- JSONB array: [{ t: ISO string, hr?: int, speedMs?, power?, cadence? }]
  "samples"      JSONB NOT NULL,
  -- Denormalised samples.length — sized without parsing the blob.
  "sample_count" INTEGER NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
