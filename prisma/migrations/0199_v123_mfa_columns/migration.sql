-- v1.23 — account-security columns (second-factor substrate).
--
-- Additive, nullable / defaulted columns only — existing rows need no
-- backfill. The TOTP shared secret (`totp_secret_encrypted`) is AES-256-GCM
-- ciphertext like every other `*_encrypted` column (registered in the
-- encrypted-columns registry + the rotation script). `totp_confirmed_at`
-- marks the pending->active promotion; `mfa_enforced` /
-- `passkey_upgrade_nudge_dismissed` are per-account flags later waves read.
--
-- `sessions.mfa_verified_at` is the step-up freshness stamp; `last_active_at`
-- backs the user-facing active-session list. `passkeys.last_used_at` is set on
-- each successful assertion so the management UI can surface "last used".
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totp_secret_encrypted" TEXT,
  ADD COLUMN IF NOT EXISTS "totp_confirmed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mfa_enforced" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "passkey_upgrade_nudge_dismissed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "mfa_verified_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "last_active_at" TIMESTAMP(3);

ALTER TABLE "passkeys"
  ADD COLUMN IF NOT EXISTS "last_used_at" TIMESTAMP(3);
