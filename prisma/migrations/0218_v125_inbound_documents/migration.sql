-- v1.25 (W-DOCS-IN) — inbound clinical documents + extracted-fact staging.
--
-- A self-hoster uploads a doctor report / discharge letter they received.
-- The raw document is stored encrypted at rest (BYTEA, the AES-256-GCM
-- `*_encrypted` convention shared with the illness / mood / lab note
-- columns). The dedicated OCR/vision provider transcribes STRUCTURED FACTS
-- into a review-then-confirm staging area (`extracted_facts`). The app
-- reproduces what the clinician wrote — it never interprets, never
-- range-flags, never diagnoses, never links a condition to a medication. A
-- fact reaches the structured stores (labs / conditions / medications) only
-- on explicit user approval; low-confidence facts fail closed.
--
-- `mime_type`, `byte_size`, `provider_type`, `report_date` stay queryable
-- plaintext metadata; `content_encrypted` holds the sensitive original. The
-- per-fact `data_json` / `provenance_json` carry the FHIR-staged fields
-- (stated codes only) and the source-span provenance.
--
-- Additive; no existing row touched. Idempotent guards (`IF NOT EXISTS` /
-- `DO $$`) so reruns are safe on prod.
--
-- Reversibility (down):
--   DROP TABLE IF EXISTS "extracted_facts";
--   DROP TABLE IF EXISTS "inbound_documents";
--   DROP TYPE  IF EXISTS "extracted_fact_status";
--   DROP TYPE  IF EXISTS "extracted_fact_type";
--   DROP TYPE  IF EXISTS "inbound_document_status";
--   DROP TYPE  IF EXISTS "inbound_document_kind";
-- A roll-back drops the inbound-document store wholesale — facts already
-- approved into labs / conditions / medications are independent rows and are
-- NOT affected (the staging link is one-way).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "inbound_document_kind" AS ENUM ('DOCTOR_REPORT', 'DISCHARGE_LETTER', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "inbound_document_status" AS ENUM ('EXTRACTING', 'EXTRACTED', 'FAILED', 'CONFIRMED', 'DISCARDED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "extracted_fact_type" AS ENUM ('CONDITION', 'OBSERVATION', 'MEDICATION_STATEMENT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "extracted_fact_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "inbound_documents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "inbound_document_kind" NOT NULL DEFAULT 'OTHER',
    "filename" TEXT,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "content_encrypted" BYTEA NOT NULL,
    "status" "inbound_document_status" NOT NULL DEFAULT 'EXTRACTING',
    "provider_type" TEXT,
    "report_date" TIMESTAMP(3),
    "error_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "inbound_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "extracted_facts" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "fact_type" "extracted_fact_type" NOT NULL,
    "status" "extracted_fact_status" NOT NULL DEFAULT 'PENDING',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "needs_review" BOOLEAN NOT NULL DEFAULT true,
    "data_json" JSONB NOT NULL,
    "provenance_json" JSONB NOT NULL,
    "committed_record_id" TEXT,
    "committed_record_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extracted_facts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "inbound_documents_user_id_created_at_idx" ON "inbound_documents"("user_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "inbound_documents_user_id_deleted_at_idx" ON "inbound_documents"("user_id", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "extracted_facts_document_id_idx" ON "extracted_facts"("document_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "extracted_facts_user_id_idx" ON "extracted_facts"("user_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "inbound_documents" ADD CONSTRAINT "inbound_documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "extracted_facts" ADD CONSTRAINT "extracted_facts_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "inbound_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "extracted_facts" ADD CONSTRAINT "extracted_facts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
