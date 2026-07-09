-- Operator-shared central Codex (ChatGPT subscription) OAuth + per-user opt-in.
--
-- The only operator-level AI credential so far has been an API key
-- (`app_settings.admin_ai_key_encrypted`). This adds an operator-level Codex
-- OAuth credential: the operator connects ONE signed-in ChatGPT account (the
-- same device-code flow the per-user `codex_*_encrypted` columns use) and shares
-- it server-wide. Each user opts in individually via `users.use_central_codex`.
--
-- All columns are additive and defaulted, so existing rows keep the current
-- behaviour (no central Codex, no user opted in) with no backfill. The three
-- token pieces are AES-256-GCM encrypted at rest, same crypto as every other
-- `*_encrypted` column, so the key-rotation script covers them.
--
-- Routing through the central Codex is external egress on a shared,
-- train-by-default consumer account bound by the operator's own rate limits.
-- It is consent-gated (server-managed provider) and billed against the operator
-- cost cap, never the user plan. OFF until the operator connects it.

ALTER TABLE "app_settings"
  ADD COLUMN "admin_codex_access_token_encrypted"  TEXT,
  ADD COLUMN "admin_codex_refresh_token_encrypted" TEXT,
  ADD COLUMN "admin_codex_account_id_encrypted"    TEXT,
  ADD COLUMN "admin_codex_token_expires_at"        TIMESTAMP(3),
  ADD COLUMN "admin_codex_connected_at"            TIMESTAMP(3),
  ADD COLUMN "admin_codex_connection_status"       TEXT NOT NULL DEFAULT 'disconnected';

ALTER TABLE "users"
  ADD COLUMN "use_central_codex" BOOLEAN NOT NULL DEFAULT false;
