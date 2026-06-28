-- v1.25 — clinical-signals wave: validated mental-health screeners (PHQ-9 + GAD-7).
--
-- Adds the two derived total-score MeasurementType members and the
-- `mental_health_assessments` table that holds one completed administration per
-- row. The per-item answers ride a single AES-256-GCM `bytea` blob
-- (`responses_encrypted`); only the derived total / band / item-9 flag are
-- stored in the clear, for cheap history reads. Opt-in, beside mood tracking.

-- New MeasurementType members for the derived scores. ADD VALUE IF NOT EXISTS is
-- idempotent and not used within this migration, so the in-transaction guard
-- does not apply.
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'PHQ9_SCORE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'GAD7_SCORE';

-- Instrument discriminator.
CREATE TYPE "assessment_instrument" AS ENUM ('PHQ9', 'GAD7');

CREATE TABLE "mental_health_assessments" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "instrument" "assessment_instrument" NOT NULL,
    "locale" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'standard',
    "responses_encrypted" BYTEA NOT NULL,
    "total_score" INTEGER NOT NULL,
    "severity_band" TEXT NOT NULL,
    "item9_flagged" BOOLEAN NOT NULL DEFAULT false,
    "crisis_shown_at" TIMESTAMP(3),
    "taken_at" TIMESTAMP(3) NOT NULL,
    "tz" TEXT,
    "source" TEXT NOT NULL DEFAULT 'WEB',
    "external_id" TEXT,
    "sync_version" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mental_health_assessments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mental_health_assessments_user_id_source_external_id_key" ON "mental_health_assessments"("user_id", "source", "external_id");
CREATE INDEX "mental_health_assessments_user_id_instrument_taken_at_idx" ON "mental_health_assessments"("user_id", "instrument", "taken_at");
CREATE INDEX "mental_health_assessments_user_id_updated_at_id_idx" ON "mental_health_assessments"("user_id", "updated_at", "id");

ALTER TABLE "mental_health_assessments" ADD CONSTRAINT "mental_health_assessments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
