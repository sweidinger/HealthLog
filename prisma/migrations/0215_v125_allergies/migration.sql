-- v1.25 (W-RECORDS) — structured allergies / intolerances.
--
-- A self-recorded AllergyIntolerance-style record: substance + category +
-- type + severity + status + optional onset, with the free-text reaction
-- description and notes encrypted at rest (BYTEA, the AES-256-GCM
-- `*_encrypted` convention shared with the illness / mood / lab note
-- columns). The `substance` label stays queryable plaintext (the
-- medication.name / illness.label precedent) — it rides the FHIR
-- AllergyIntolerance `code.text` anchor, never a machine-guessed code.
--
-- Patient-reported reference data, not a time-series signal and not a
-- clinical diagnosis. Soft-deleted (`deleted_at`). Owner-scoped via the FK.
--
-- Additive; no existing row touched. Idempotent guards (`IF NOT EXISTS` /
-- `DO $$`) so reruns are safe on prod.
--
-- Reversibility (down):
--   DROP TABLE IF EXISTS "allergies";
--   DROP TYPE  IF EXISTS "allergy_status";
--   DROP TYPE  IF EXISTS "allergy_severity";
--   DROP TYPE  IF EXISTS "allergy_type";
--   DROP TYPE  IF EXISTS "allergy_category";
-- A roll-back drops the allergy record wholesale — no other domain depends
-- on it.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "allergy_category" AS ENUM ('FOOD', 'MEDICATION', 'ENVIRONMENT', 'BIOLOGIC', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "allergy_type" AS ENUM ('ALLERGY', 'INTOLERANCE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "allergy_severity" AS ENUM ('MILD', 'MODERATE', 'SEVERE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "allergy_status" AS ENUM ('ACTIVE', 'INACTIVE', 'RESOLVED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "allergies" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "substance" TEXT NOT NULL,
    "category" "allergy_category" NOT NULL DEFAULT 'OTHER',
    "type" "allergy_type" NOT NULL DEFAULT 'ALLERGY',
    "severity" "allergy_severity",
    "status" "allergy_status" NOT NULL DEFAULT 'ACTIVE',
    "onset_at" TIMESTAMP(3),
    "reaction_encrypted" BYTEA,
    "notes_encrypted" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "allergies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "allergies_user_id_deleted_at_idx" ON "allergies"("user_id", "deleted_at");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "allergies" ADD CONSTRAINT "allergies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
