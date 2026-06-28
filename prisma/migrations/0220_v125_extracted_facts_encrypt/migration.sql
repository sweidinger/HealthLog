-- v1.25 (W-DOCS-IN, security) — encrypt the staged extracted-fact payloads.
--
-- The inbound-document store already encrypts the raw upload
-- (`inbound_documents.content_encrypted`) precisely because it is sensitive
-- PHI. The per-fact staging columns `extracted_facts.data_json` /
-- `provenance_json`, however, persisted the SAME class of data in the clear:
-- the FHIR-staged clinical values (diagnosis text, lab values, medication
-- names, stated codes) and the verbatim source span (up to 2000 chars copied
-- straight out of the discharge letter / lab report). That defeated the
-- at-rest guarantee for the feature. This migration converts both columns to
-- the AES-256-GCM `*_encrypted` BYTEA convention shared with the note columns;
-- the application encrypts on write and decrypts at confirm time.
--
-- Transactional + fail-closed: encryption is application-layer, so the plaintext
-- JSONB cannot be re-encrypted in SQL. Staged facts are EPHEMERAL pre-confirm
-- (nothing committed until the user approves them) and this feature has not
-- shipped, so any rows staged by a pre-release build carry plaintext PHI we
-- will not retain — they are dropped here rather than left unencrypted, and
-- their parent document keeps its encrypted original and can be re-extracted.
-- The whole migration runs in one transaction, so a failure rolls back wholly.
--
-- Reversibility (down) — re-add the plaintext columns (data is not recoverable):
--   ALTER TABLE "extracted_facts" ADD COLUMN "data_json" JSONB;
--   ALTER TABLE "extracted_facts" ADD COLUMN "provenance_json" JSONB;
--   ALTER TABLE "extracted_facts" DROP COLUMN "data_encrypted";
--   ALTER TABLE "extracted_facts" DROP COLUMN "provenance_encrypted";

-- Add the encrypted replacements (nullable during the swap).
ALTER TABLE "extracted_facts" ADD COLUMN IF NOT EXISTS "data_encrypted" BYTEA;
ALTER TABLE "extracted_facts" ADD COLUMN IF NOT EXISTS "provenance_encrypted" BYTEA;

-- Drop any pre-release staged rows: their plaintext payload cannot be
-- re-encrypted in SQL, and a pre-confirm fact carries no committed data.
DELETE FROM "extracted_facts" WHERE "data_encrypted" IS NULL;

-- Enforce the at-rest guarantee: every staged fact now carries ciphertext.
ALTER TABLE "extracted_facts" ALTER COLUMN "data_encrypted" SET NOT NULL;
ALTER TABLE "extracted_facts" ALTER COLUMN "provenance_encrypted" SET NOT NULL;

-- Drop the plaintext columns so no verbatim clinical span survives.
ALTER TABLE "extracted_facts" DROP COLUMN IF EXISTS "data_json";
ALTER TABLE "extracted_facts" DROP COLUMN IF EXISTS "provenance_json";
