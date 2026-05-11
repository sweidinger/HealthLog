-- v1.4.23 — Apple Health backend foundation
--
-- Adds the enum values, columns, and composite unique index the
-- HealthKit batch-ingest endpoint needs. Strictly additive:
--   * No existing rows are rewritten.
--   * New columns are nullable.
--   * New enum values append (no reordering).
--   * The new composite unique index treats NULL externalId rows as
--     distinct (Postgres semantics) so manual entries — which have no
--     external id — don't collide.
--
-- Unit semantics change (advisory, no row mutation): `SLEEP_DURATION`
-- shifts from hours to minutes so per-stage HealthKit category samples
-- can be stored without precision loss. No production data exists for
-- this enum value yet (per the v1.4.23 W1 research), so the change is
-- effectively schema-only — the application enforces the new unit going
-- forward via `getUnitForType()`.
--
-- Pre-deploy verification (v1.4.23 W6 reconcile, Sec MED cluster):
-- Before tagging v1.4.23 the maintainer MUST run
--   psql -c "select count(*) from measurements where type = 'SLEEP_DURATION'"
-- and confirm the result is `0`. If the count is non-zero, this
-- migration's "schema-only" assumption no longer holds and the operator
-- has to ship a one-shot data-migration multiplying every existing
-- SLEEP_DURATION row's `value` column by 60 (hours → minutes) BEFORE
-- this migration is applied. Skipping the check would silently rewrite
-- the unit semantics on rows that were ingested under the old contract,
-- shrinking displayed sleep duration by 60× without rewriting the
-- stored numeric.

-- ── MeasurementType — append 7 Apple-Health-shaped enum values ──────

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'HEART_RATE_VARIABILITY';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'RESTING_HEART_RATE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'ACTIVE_ENERGY_BURNED';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'FLIGHTS_CLIMBED';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WALKING_RUNNING_DISTANCE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'VO2_MAX';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'BODY_TEMPERATURE';

-- ── MeasurementSource — append APPLE_HEALTH ─────────────────────────

ALTER TYPE "measurement_source" ADD VALUE IF NOT EXISTS 'APPLE_HEALTH';

-- ── SleepStage — new enum mirroring HKCategoryValueSleepAnalysis ────

CREATE TYPE "sleep_stage" AS ENUM (
  'IN_BED',
  'AWAKE',
  'ASLEEP',
  'REM',
  'CORE',
  'DEEP'
);

-- ── Measurement — new nullable columns + composite unique index ─────

ALTER TABLE "measurements"
  ADD COLUMN "external_source_version" TEXT,
  ADD COLUMN "sleep_stage" "sleep_stage";

-- Enforce: sleep_stage is only set for SLEEP_DURATION rows. Mirrors the
-- glucose_context CHECK constraint from migration 0021.
ALTER TABLE "measurements"
  ADD CONSTRAINT "measurements_sleep_stage_requires_type"
  CHECK (
    sleep_stage IS NULL
    OR (sleep_stage IS NOT NULL AND type = 'SLEEP_DURATION')
  );

-- Composite unique index — dedup key for the Apple Health batch ingest
-- endpoint. Postgres treats NULL as distinct in unique indexes, so
-- manual entries (external_id = NULL) don't collide with each other or
-- with imported rows. Withings ingest historically used externalId
-- alongside the legacy `(userId, type, measuredAt, source)` unique
-- index — both indexes coexist; the legacy one stays as the manual-UI
-- "no duplicate at the same wall-clock" guard.
CREATE UNIQUE INDEX "measurements_user_id_type_source_external_id_key"
  ON "measurements" ("user_id", "type", "source", "external_id");
