-- Document vault P4: chat about a document.
--
-- Two additive, nullable columns — no backfill, applies clean on a 0229
-- database and on a fresh database:
--
--   1. `coach_conversations.document_id` — the discriminator that turns a Coach
--      conversation into a DOCUMENT chat. NULL = a normal Coach conversation
--      (health-record surface). Non-NULL = a chat scoped to exactly one stored
--      document, whose only context is that document's text (no health snapshot,
--      no tools). FK cascades: deleting the document removes its chats. A
--      composite index covers both the Coach rail scan (`document_id IS NULL`,
--      newest-first) and the document sheet scan (`document_id = <id>`,
--      newest-first).
--
--   2. `document_content_index.verbatim_text_encrypted` — AES-256-GCM ciphertext
--      of the VERBATIM extracted text (byte-capped, not lowercased/de-accented),
--      stored additionally alongside the normalised `text_encrypted` so a chat
--      can cite the document faithfully. Nullable: rows indexed before P4 carry
--      NULL until re-indexed, and the chat route falls back to `text_encrypted`.

-- AlterTable
ALTER TABLE "coach_conversations"
  ADD COLUMN "document_id" TEXT;

-- AlterTable
ALTER TABLE "document_content_index"
  ADD COLUMN "verbatim_text_encrypted" BYTEA;

-- CreateIndex — covers the Coach rail (document_id IS NULL) and the document
-- sheet (document_id = <id>) newest-first scans with one composite.
CREATE INDEX "coach_conversations_user_id_document_id_updated_at_idx"
  ON "coach_conversations" ("user_id", "document_id", "updated_at");

-- AddForeignKey — a deleted document takes its chats with it.
ALTER TABLE "coach_conversations"
  ADD CONSTRAINT "coach_conversations_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "inbound_documents" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
