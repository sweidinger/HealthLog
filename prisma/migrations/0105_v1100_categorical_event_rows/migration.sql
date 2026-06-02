-- v1.10.0 — categorical EVENT row class + device rhythm classification.
--
-- Adds a discrete EVENT row class to the existing `Measurement` model,
-- following the `sleep_stage` / `glucose_context` nullable-context
-- precedent (migration 0021 + 0036) — an additive nullable column on the
-- existing table, NOT a new storage paradigm. An EVENT row stores ONE
-- on-device notification the user's wearable already produced (Apple Watch
-- irregular-rhythm / high-HR / low-HR / walking-steadiness, ScanWatch AFib
-- screening, sleep breathing-disturbance). `value` is always 1; the
-- device's own verdict / severity rides in the new `rhythm_classification`
-- column.
--
-- ── Regulatory framing (load-bearing) ──────────────────────────────────
-- HealthLog stores ONLY the classification RESULT the device's
-- FDA-cleared / CE-marked on-device algorithm emitted. It never ingests a
-- raw ECG waveform, never re-classifies, and never produces a HealthLog
-- diagnosis. The surface is awareness/screening of the DEVICE's decision.
--
-- Two schema objects:
--
--   1. Five new `measurement_type` enum values (the EVENT classes).
--   2. A new `rhythm_classification` enum + a nullable column carrying the
--      device verdict / severity, NULL for every continuous measurement.
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe. Forward-only.
--
-- Reversibility:
--   ALTER TABLE "measurements" DROP CONSTRAINT IF EXISTS "measurements_rhythm_classification_requires_event_type";
--   ALTER TABLE "measurements" DROP COLUMN IF EXISTS "rhythm_classification";
--   DROP TYPE IF EXISTS "rhythm_classification";
-- Postgres does not support removing an enum value, so the five new
-- `measurement_type` members stay; with no rows carrying them after a
-- column drop they are inert.

-- ── 1. measurement_type — append the five EVENT classes ────────────────
-- Pure additive; no existing row carries any of these values. The
-- `IF NOT EXISTS` guard keeps the migration idempotent across a
-- partially-applied environment.
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'IRREGULAR_RHYTHM_NOTIFICATION';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'HIGH_HEART_RATE_EVENT';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'LOW_HEART_RATE_EVENT';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WALKING_STEADINESS_EVENT';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'BREATHING_DISTURBANCE_EVENT';

-- ── 2. rhythm_classification — the device verdict / severity enum ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rhythm_classification') THEN
    CREATE TYPE "rhythm_classification" AS ENUM (
      'IRREGULAR',
      'NOT_DETECTED',
      'INCONCLUSIVE',
      'LOW',
      'VERY_LOW',
      'FIRED'
    );
  END IF;
END
$$;

-- Nullable column. NULL for every continuous measurement; non-NULL only
-- for the EVENT classes. Mirrors the `sleep_stage` additive-column shape.
ALTER TABLE "measurements"
  ADD COLUMN IF NOT EXISTS "rhythm_classification" "rhythm_classification";

-- Enforce: rhythm_classification is only set for the EVENT-class rows.
-- Mirrors the `measurements_sleep_stage_requires_type` CHECK (migration
-- 0036) and the glucose_context CHECK (migration 0021).
--
-- The comparison casts `type` to text so the predicate references the
-- newly-added enum members as string literals. Postgres forbids using an
-- enum value in the same transaction that adds it (the ALTER TYPE ... ADD
-- VALUE statements above run in this same migration transaction); the
-- `::text` cast sidesteps that restriction without weakening the check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'measurements_rhythm_classification_requires_event_type'
  ) THEN
    ALTER TABLE "measurements"
      ADD CONSTRAINT "measurements_rhythm_classification_requires_event_type"
      CHECK (
        "rhythm_classification" IS NULL
        OR "type"::text IN (
          'IRREGULAR_RHYTHM_NOTIFICATION',
          'HIGH_HEART_RATE_EVENT',
          'LOW_HEART_RATE_EVENT',
          'WALKING_STEADINESS_EVENT',
          'BREATHING_DISTURBANCE_EVENT'
        )
      );
  END IF;
END
$$;
