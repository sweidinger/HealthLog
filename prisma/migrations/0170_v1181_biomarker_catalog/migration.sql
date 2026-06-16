-- v1.18.1 — user-scoped biomarker catalog.
--
-- The lean v1.17.1 `lab_results` row stores analyte / unit / reference_low /
-- reference_high on EVERY row, so recording the same marker three times means
-- re-typing the name + unit + both bounds three times — each an opportunity
-- to fork the "same" biomarker into "LDL" / "ldl" / "LDL-C" or mistype
-- `mg/dL` as `mg/dl`. This adds a per-user catalog that defines a marker ONCE
-- (canonical name, unit, reference bounds, optional context note); readings
-- link to it and resolve their range/unit from the catalog row.
--
--   * `biomarkers` table — user-scoped, unique per (user_id, name) so there
--     is never two "LDL" definitions. `context_encrypted` is a Bytes column
--     (the AES-256-GCM `*Encrypted` convention). `lower_bound` / `upper_bound`
--     are the optional reference window; `panel` is the optional grouping
--     moved off the per-entry row.
--
--   * `lab_results.biomarker_id` (nullable FK) — every existing row stays
--     NULL. A pg-boss backfill job (not a tsx CLI per the standalone-image
--     rule) will later GROUP BY lower(analyte) per user, mint one Biomarker
--     per group, and link the rows. This migration only adds the column +
--     relation + supporting index; no row is touched, no data destroyed.
--     ON DELETE SET NULL: deleting a catalog marker orphans its readings
--     (they keep their legacy analyte/unit/reference columns) rather than
--     cascading the historical values away.
--
-- Additive throughout; no backfill in the migration itself.
--
-- Idempotent guards (`IF NOT EXISTS`) so reruns are safe on prod. The FK is
-- added under a DO-block existence guard for the same reason.
--
-- Reversibility (down):
--   ALTER TABLE "lab_results" DROP CONSTRAINT IF EXISTS "lab_results_biomarker_id_fkey";
--   DROP INDEX IF EXISTS "lab_results_biomarker_id_idx";
--   ALTER TABLE "lab_results" DROP COLUMN IF EXISTS "biomarker_id";
--   DROP TABLE IF EXISTS "biomarkers";
-- A roll-back drops the catalog + un-links readings (which keep their legacy
-- per-row analyte/unit/reference values), the safe default — no reading lost.

-- CreateTable
CREATE TABLE IF NOT EXISTS "biomarkers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "lower_bound" DOUBLE PRECISION,
    "upper_bound" DOUBLE PRECISION,
    "context_encrypted" BYTEA,
    "panel" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "biomarkers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "biomarkers_user_id_name_key" ON "biomarkers"("user_id", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "biomarkers_user_id_idx" ON "biomarkers"("user_id");

-- AlterTable
ALTER TABLE "lab_results"
    ADD COLUMN IF NOT EXISTS "biomarker_id" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "lab_results_biomarker_id_idx" ON "lab_results"("biomarker_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "biomarkers" ADD CONSTRAINT "biomarkers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_biomarker_id_fkey" FOREIGN KEY ("biomarker_id") REFERENCES "biomarkers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
