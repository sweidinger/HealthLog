-- Document vault: re-enable the parked inbound-documents module with the
-- hardened storage contract.
--
--   1. `inbound_document_kind` gains REFERRAL (Überweisung — clean LOINC
--      57133-1 / ePA ANF mapping).
--   2. `inbound_documents` gains `content_sha256` (lowercase hex of the
--      plaintext, for same-user duplicate detection; pre-existing rows stay
--      NULL and never dedupe) and `content_codec` ("base64v1" legacy string
--      codec | "binary2" binary codec; the default keeps existing rows
--      correct) plus a partial unique index enforcing at most one LIVE row
--      per (user_id, content_sha256).
--   3. `document_condition_links` — m:n join between a document and an
--      illness/condition episode. Both sides cascade.
--   4. `app_settings` gains the two admin-tunable limits (per-file cap,
--      default 25 MiB; per-user quota, default 1 GiB); `users` gains the
--      nullable per-user quota override.
--
-- Additive and idempotent-safe on an existing database; applies clean on a
-- fresh database as part of the ordered migration chain.

-- 1. Kind enum
ALTER TYPE "inbound_document_kind" ADD VALUE IF NOT EXISTS 'REFERRAL';

-- 2. Document columns + live-dedupe partial unique index
ALTER TABLE "inbound_documents"
  ADD COLUMN "content_sha256" VARCHAR(64),
  ADD COLUMN "content_codec" TEXT NOT NULL DEFAULT 'base64v1';

-- Partial unique index (documented in schema.prisma — Prisma cannot express
-- a partial index, so it lives here as raw SQL). Tombstoned rows are
-- excluded: a soft-deleted document must not block re-uploading the same
-- file, and restore re-enters the constraint (a conflicting restore 409s).
CREATE UNIQUE INDEX "inbound_documents_user_sha_live"
  ON "inbound_documents" ("user_id", "content_sha256")
  WHERE "deleted_at" IS NULL AND "content_sha256" IS NOT NULL;

-- 3. Document ⇄ condition links
CREATE TABLE "document_condition_links" (
  "id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "episode_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "document_condition_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_condition_links_document_id_episode_id_key"
  ON "document_condition_links" ("document_id", "episode_id");

CREATE INDEX "document_condition_links_episode_id_idx"
  ON "document_condition_links" ("episode_id");

CREATE INDEX "document_condition_links_user_id_idx"
  ON "document_condition_links" ("user_id");

ALTER TABLE "document_condition_links"
  ADD CONSTRAINT "document_condition_links_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "inbound_documents" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_condition_links"
  ADD CONSTRAINT "document_condition_links_episode_id_fkey"
  FOREIGN KEY ("episode_id") REFERENCES "illness_episodes" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_condition_links"
  ADD CONSTRAINT "document_condition_links_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Admin limits
ALTER TABLE "app_settings"
  ADD COLUMN "document_max_file_bytes" INTEGER NOT NULL DEFAULT 26214400,
  ADD COLUMN "document_quota_bytes" BIGINT NOT NULL DEFAULT 1073741824;

ALTER TABLE "users"
  ADD COLUMN "document_quota_bytes" BIGINT;
