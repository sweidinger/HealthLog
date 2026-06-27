-- v1.22 (#89 + #90) — AI-settings wave.
--
-- Two additive, UI/DB-backed features on the per-user AI config (no new env
-- vars — every value is configured in the app):
--
--   #89 ai_response_timeout_seconds — per-user response timeout for AI
--       generation, in SECONDS. Threaded onto CompletionParams.timeoutMs
--       (x1000). NULL = the generous built-in default (~180 s). Surfaced in
--       Settings -> AI mainly for local/self-hosted servers where the first
--       request can take >60 s while the model loads.
--
--   #90 dedicated document-scan (Lab-OCR) provider. OFF by default
--       (ai_ocr_enabled = false) -> the OCR ingestion uses the main provider
--       chain unchanged. When enabled, the OCR path resolves this dedicated
--       provider/model/key instead. ai_ocr_key_encrypted is AES-256-GCM
--       ciphertext like every other *_encrypted column (registered in the
--       encrypted-columns registry + the rotation script).
--
-- All columns are nullable / defaulted, so existing rows need no backfill.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "ai_response_timeout_seconds" INTEGER,
  ADD COLUMN IF NOT EXISTS "ai_ocr_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "ai_ocr_provider" TEXT,
  ADD COLUMN IF NOT EXISTS "ai_ocr_model" TEXT,
  ADD COLUMN IF NOT EXISTS "ai_ocr_base_url" TEXT,
  ADD COLUMN IF NOT EXISTS "ai_ocr_key_encrypted" TEXT;
