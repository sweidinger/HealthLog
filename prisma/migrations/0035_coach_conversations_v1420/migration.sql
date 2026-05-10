-- v1.4.20 — AI Coach persistence + per-day token-spend ledger.
--
-- Three new tables:
--   coach_conversations  — one row per chat thread, owned by a user.
--   coach_messages       — encrypted message text + provenance metadata.
--   coach_usage          — per-(user, day) token ledger for budget gating.
--
-- Encryption: `coach_messages.encrypted_content` is AES-256-GCM
-- ciphertext written via `src/lib/crypto.ts` under the active
-- `ENCRYPTION_KEYS` entry. Key rotation works the same way as for the
-- existing encrypted columns (Withings tokens, Telegram bot tokens,
-- moodLog API keys). `metric_source_json` is intentionally plain text
-- — it stores window + metric labels only ("last30days", "n=12"),
-- never raw values, so analytics queries can slice it without a key.
--
-- GDPR: every table cascades on user delete via FK chains, covered
-- end-to-end in tests/integration/cascade-delete.test.ts.

CREATE TABLE "coach_conversations" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "coach_conversations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "coach_conversations_user_id_updated_at_idx"
  ON "coach_conversations" ("user_id", "updated_at");

ALTER TABLE "coach_conversations"
  ADD CONSTRAINT "coach_conversations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "coach_messages" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "encrypted_content" BYTEA NOT NULL,
  "metric_source_json" TEXT,
  "provider_type" TEXT,
  "prompt_version" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "coach_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "coach_messages_conversation_id_created_at_idx"
  ON "coach_messages" ("conversation_id", "created_at");

ALTER TABLE "coach_messages"
  ADD CONSTRAINT "coach_messages_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "coach_conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "coach_usage" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "date_key" TEXT NOT NULL,
  "total_tokens" INTEGER NOT NULL DEFAULT 0,
  "message_count" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "coach_usage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coach_usage_user_id_date_key_key"
  ON "coach_usage" ("user_id", "date_key");

CREATE INDEX "coach_usage_user_id_date_key_idx"
  ON "coach_usage" ("user_id", "date_key");

ALTER TABLE "coach_usage"
  ADD CONSTRAINT "coach_usage_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
