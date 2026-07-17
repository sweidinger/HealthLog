-- Persist a short plain-language summary of an uploaded document.
--
-- Adds two nullable columns to `inbound_documents`:
--   - `summary_encrypted` — AES-256-GCM ciphertext of a 3-4 sentence
--     plain-language description of WHAT the document is, generated ONCE in
--     the background right after upload when the user's `documents_auto_ai_read`
--     opt-in is ON (that flag is also the standing AI-egress consent). NULL
--     when auto-read is OFF, no provider is configured, or generation has not
--     run yet.
--   - `summary_generated_at` — when that background summary was generated
--     (NULL until it runs).
--
-- STORAGE CONVENTION: Bytes (`bytea`), matching the dominant free-text
-- encrypted-note convention already in the schema (the `encrypt()` ciphertext
-- string stored UTF-8 as `bytea`, the shape the rotation script's
-- `rotateBytesColumn` already covers). The column is registered in
-- ENCRYPTED_COLUMNS + the rotation script in the same change.
--
-- ADDITIVE ONLY: existing rows keep NULL summaries; the on-demand transient
-- summary route is unchanged.
ALTER TABLE "inbound_documents"
  ADD COLUMN IF NOT EXISTS "summary_encrypted" BYTEA,
  ADD COLUMN IF NOT EXISTS "summary_generated_at" TIMESTAMP(3);
