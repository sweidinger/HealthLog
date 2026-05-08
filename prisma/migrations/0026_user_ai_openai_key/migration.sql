-- v1.4.3: per-user OpenAI API key.
--
-- Until this release the schema stored Anthropic and Local-provider API
-- keys but no field for the OPENAI provider, even though OPENAI was a
-- valid value in `users.ai_provider`. Users who picked it had no place
-- in the UI to drop their key and the runtime fell through to whichever
-- admin-level fallback was configured. This column is the missing slot.
--
-- AES-256-GCM encrypted at the application layer (`src/lib/crypto.ts`)
-- before the value lands on disk. Plaintext keys never touch Postgres
-- backups.

ALTER TABLE "users"
  ADD COLUMN "ai_openai_key_encrypted" TEXT;
