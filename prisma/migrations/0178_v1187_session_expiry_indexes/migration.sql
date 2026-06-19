-- v1.18.7 — expiry indexes for the two tables swept by the session reaper.
--
-- `sessions` (sliding-30-day session expiry) and `auth_challenges` (passkey
-- registration / authentication challenges) are both pruned on `expires_at`,
-- but neither carried an index on that column. On a busy multi-user instance
-- the cleanup degraded to a sequential scan. Every sibling expiry table
-- (`refresh_tokens`, `whoop_oauth_states`, `idempotency_keys`,
-- `withings_oauth_states`, …) already indexes its expiry column; this brings
-- the two stragglers in line. Additive; no data touched.
--
-- Reversibility (down):
--   DROP INDEX IF EXISTS "sessions_expires_at_idx";
--   DROP INDEX IF EXISTS "auth_challenges_expires_at_idx";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "auth_challenges_expires_at_idx" ON "auth_challenges"("expires_at");
