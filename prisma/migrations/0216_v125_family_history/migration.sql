-- v1.25 (W-RECORDS) — structured family history.
--
-- One condition recorded for one relative (a FHIR FamilyMemberHistory with a
-- single condition): relationship + condition label + optional age-at-onset,
-- with the optional free-text note encrypted at rest (BYTEA, the AES-256-GCM
-- `*_encrypted` convention). The `condition` label stays queryable plaintext
-- (the medication.name / illness.label precedent) — it rides the FHIR
-- FamilyMemberHistory `condition.code.text` anchor, never a machine-guessed
-- code.
--
-- Patient-reported reference data, not a time-series signal and not a clinical
-- diagnosis. Soft-deleted (`deleted_at`). Owner-scoped via the FK.
--
-- Additive; no existing row touched. Idempotent guards (`IF NOT EXISTS` /
-- `DO $$`) so reruns are safe on prod.
--
-- Reversibility (down):
--   DROP TABLE IF EXISTS "family_history_entries";
--   DROP TYPE  IF EXISTS "family_relationship";
-- A roll-back drops the family-history record wholesale — no other domain
-- depends on it.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "family_relationship" AS ENUM (
    'MOTHER', 'FATHER', 'SISTER', 'BROTHER', 'DAUGHTER', 'SON',
    'GRANDMOTHER_MATERNAL', 'GRANDFATHER_MATERNAL',
    'GRANDMOTHER_PATERNAL', 'GRANDFATHER_PATERNAL',
    'AUNT', 'UNCLE', 'COUSIN', 'HALF_SIBLING', 'OTHER'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "family_history_entries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "relationship" "family_relationship" NOT NULL,
    "condition" TEXT NOT NULL,
    "age_at_onset" INTEGER,
    "notes_encrypted" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "family_history_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "family_history_entries_user_id_deleted_at_idx" ON "family_history_entries"("user_id", "deleted_at");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "family_history_entries" ADD CONSTRAINT "family_history_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
