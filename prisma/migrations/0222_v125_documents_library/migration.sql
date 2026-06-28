-- v1.25 — documents library: store-first, optional extraction.
--
-- Inverts the inbound-documents surface from an OCR inbox into a document
-- library. A user can now STORE any file (encrypted at rest) without a
-- configured document-scan provider; extraction becomes an optional action
-- on an already-stored row.
--
-- Schema deltas on `inbound_documents`:
--   * `title`          — user-given label, plaintext (mirrors `filename`) so
--                        the list can ILIKE-search + ORDER BY. The document
--                        BODY stays encrypted; only this short user-authored
--                        title is clear-text.
--   * `document_date`  — user-set filing date (editable). Distinct from
--                        `report_date`, which stays the model-transcribed
--                        value.
--   * a `(user_id, document_date)` index for date-grouped browse + range
--     filter.
--   * `inbound_document_kind` gains LAB_RESULT / IMAGING / PRESCRIPTION /
--     INSURANCE / VACCINATION (the existing 3 stay; OTHER stays the fallback).
--   * `inbound_document_status` gains STORED, made the column DEFAULT (the
--     library default — uploaded, no extraction run).
--
-- Additive; no existing row rewritten (the status type-swap maps every
-- existing label to itself). Nullable columns, no backfill: existing rows
-- keep their current status; `title` / `document_date` start NULL and resolve
-- through the display fallback. Idempotent guards so reruns are safe on prod.
--
-- Postgres note: a freshly-added enum value cannot be USED (e.g. as a column
-- DEFAULT) in the same transaction it is added in. Because Prisma runs each
-- migration inside a transaction, STORED cannot be added with `ALTER TYPE ...
-- ADD VALUE` and then set as the default in the same file. The status enum is
-- therefore recreated (RENAME + CREATE with the full value set + column
-- type-swap + SET DEFAULT): a type CREATEd in the current transaction MAY
-- have its values used in that same transaction, which makes the default
-- change safe. The `kind` additions are not used in this migration, so the
-- cheap `ADD VALUE IF NOT EXISTS` form is used for them.
--
-- Reversibility (down):
--   DROP INDEX IF EXISTS "inbound_documents_user_id_document_date_idx";
--   ALTER TABLE "inbound_documents" DROP COLUMN IF EXISTS "document_date";
--   ALTER TABLE "inbound_documents" DROP COLUMN IF EXISTS "title";
--   -- (added enum values are inert if unused; a roll-back leaves them
--   --  harmless rather than rewriting the type back.)

-- AlterTable: user-given title + user-set filing date (both nullable).
ALTER TABLE "inbound_documents" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "inbound_documents" ADD COLUMN IF NOT EXISTS "document_date" TIMESTAMP(3);

-- AlterEnum: richer document-kind taxonomy (additive; not used in this
-- migration, so the new values are safe to add in-place).
ALTER TYPE "inbound_document_kind" ADD VALUE IF NOT EXISTS 'LAB_RESULT';
ALTER TYPE "inbound_document_kind" ADD VALUE IF NOT EXISTS 'IMAGING';
ALTER TYPE "inbound_document_kind" ADD VALUE IF NOT EXISTS 'PRESCRIPTION';
ALTER TYPE "inbound_document_kind" ADD VALUE IF NOT EXISTS 'INSURANCE';
ALTER TYPE "inbound_document_kind" ADD VALUE IF NOT EXISTS 'VACCINATION';

-- AlterEnum: add STORED and make it the column default. Recreate the type so
-- the new value can be USED as the default in this same transaction (a
-- same-transaction CREATE TYPE permits same-transaction use of its values).
-- Guarded on STORED-absence so a rerun is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'inbound_document_status' AND e.enumlabel = 'STORED'
  ) THEN
    ALTER TYPE "inbound_document_status" RENAME TO "inbound_document_status_old";
    CREATE TYPE "inbound_document_status" AS ENUM (
      'STORED', 'EXTRACTING', 'EXTRACTED', 'FAILED', 'CONFIRMED', 'DISCARDED'
    );
    ALTER TABLE "inbound_documents" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "inbound_documents"
      ALTER COLUMN "status" TYPE "inbound_document_status"
      USING ("status"::text::"inbound_document_status");
    ALTER TABLE "inbound_documents" ALTER COLUMN "status" SET DEFAULT 'STORED';
    DROP TYPE "inbound_document_status_old";
  END IF;
END $$;

-- CreateIndex: date-grouped browse + document_date range filter.
CREATE INDEX IF NOT EXISTS "inbound_documents_user_id_document_date_idx"
  ON "inbound_documents"("user_id", "document_date");
