-- v1.11.1 — durable Coach personal facts (Epic B, B-W7).
--
-- Additive, multi-tenant-safe: one new table + index + FK, no column on an
-- existing hot table, no backfill. The fact text is encrypted at rest
-- (AES-256-GCM, same codec as coach_messages.encrypted_content); category /
-- confidence / source stay plain so the injection picker can rank without a
-- per-row decrypt. Soft-delete via deleted_at keeps "forget this" auditable.
CREATE TABLE "coach_facts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "fact_encrypted" BYTEA NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 50,
    "source_conversation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "coach_facts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "coach_facts_user_id_deleted_at_confidence_idx"
    ON "coach_facts" ("user_id", "deleted_at", "confidence");

ALTER TABLE "coach_facts"
    ADD CONSTRAINT "coach_facts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
