-- Retire the dedicated document-scan (Lab-OCR) provider.
--
-- The separate `ai_ocr_*` provider entry is gone: lab-report OCR now always
-- uses the user's main configured provider chain (the same providers, incl.
-- codex / OAuth, that the Coach and Insights already use), and a PDF is read
-- natively on Anthropic or rasterized to page images for any other vision
-- provider. The five per-user columns that backed the standalone provider are
-- no longer read or written anywhere, so drop them.
--
-- `ai_ocr_key_encrypted` was an AES-256-GCM column; it is removed from the
-- encrypted-column registry + the rotation script in the same change. Dropping
-- it here means those rows are gone before any future key rotation runs.
--
-- Idempotent (IF EXISTS); applies clean on a 0233 database and on a fresh
-- database as part of the ordered replay.
ALTER TABLE "users"
  DROP COLUMN IF EXISTS "ai_ocr_enabled",
  DROP COLUMN IF EXISTS "ai_ocr_provider",
  DROP COLUMN IF EXISTS "ai_ocr_model",
  DROP COLUMN IF EXISTS "ai_ocr_base_url",
  DROP COLUMN IF EXISTS "ai_ocr_key_encrypted";
