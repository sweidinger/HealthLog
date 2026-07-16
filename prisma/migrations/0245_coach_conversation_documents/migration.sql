-- S7: attach multiple documents to a coach conversation.
--
-- Replaces the scalar `coach_conversations.document_id` discriminator (which
-- could express only ONE document and would UNFENCE a conversation when that
-- document was deleted) with a join table + a sticky `document_scoped` flag.
--
-- The flag is the fail-closed half of the fenced-only discriminator: it is set
-- true at fenced creation / first attach and NEVER cleared. The join table
-- holds the LIVE attachment set. A count-only predicate would let a deleted
-- attachment flip a conversation (whose history may contain document-derived
-- text) back onto the tool loop; the sticky flag makes "fenced" a one-way latch
-- independent of attachment liveness.
--
-- Backfill runs in the SAME transaction as the DDL (Postgres allows it) BEFORE
-- the scalar column is dropped, so there is no dual-source-of-truth window:
-- every legacy single-doc chat becomes a one-attachment fenced conversation.

-- CreateTable
CREATE TABLE "coach_conversation_documents" (
  "conversation_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coach_conversation_documents_pkey" PRIMARY KEY ("conversation_id", "document_id")
);

-- CreateIndex — the document-sheet "chats about this doc" scan + the path-id
-- join filter the single-doc route uses.
CREATE INDEX "coach_conversation_documents_document_id_idx"
  ON "coach_conversation_documents" ("document_id");

-- AddForeignKey — deleting a conversation cascades its attachment rows away.
ALTER TABLE "coach_conversation_documents"
  ADD CONSTRAINT "coach_conversation_documents_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "coach_conversations" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey — deleting a document cascades its join rows away (its text
-- leaves every conversation's context) but NEVER the conversation itself.
ALTER TABLE "coach_conversation_documents"
  ADD CONSTRAINT "coach_conversation_documents_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "inbound_documents" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable — the sticky fence flag.
ALTER TABLE "coach_conversations"
  ADD COLUMN "document_scoped" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every legacy single-doc chat becomes a one-attachment fenced
-- conversation. Runs BEFORE the DROP COLUMN below.
INSERT INTO "coach_conversation_documents" ("conversation_id", "document_id", "added_at")
  SELECT "id", "document_id", "created_at"
  FROM "coach_conversations"
  WHERE "document_id" IS NOT NULL;

UPDATE "coach_conversations" SET "document_scoped" = true
  WHERE "document_id" IS NOT NULL;

-- The scalar discriminator goes away in the SAME migration — no dual-source-of-
-- truth window, no "in case" shim. Every reader is repointed in the same
-- release. Drop the FK + covering index first, then the column.
ALTER TABLE "coach_conversations"
  DROP CONSTRAINT "coach_conversations_document_id_fkey";

DROP INDEX "coach_conversations_user_id_document_id_updated_at_idx";

ALTER TABLE "coach_conversations"
  DROP COLUMN "document_id";

-- CreateIndex — the rail + tool-route-send predicate on the sticky flag.
CREATE INDEX "coach_conversations_user_id_document_scoped_updated_at_idx"
  ON "coach_conversations" ("user_id", "document_scoped", "updated_at");
