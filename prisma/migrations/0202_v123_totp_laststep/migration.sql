-- v1.23 — TOTP replay guard.
--
-- Persists the last accepted time-step counter per account so a verified
-- code cannot be replayed within its 30-second validity window. The verify
-- path resolves the submitted code to its RFC 6238 step (`floor(now /
-- period)` adjusted by the ±1 drift delta) and rejects any step that is not
-- strictly greater than this column. Additive, nullable — existing rows
-- (no TOTP enrolled) need no backfill, and a freshly confirmed factor starts
-- with NULL (the first verify simply records its step).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "totp_last_step" BIGINT;
