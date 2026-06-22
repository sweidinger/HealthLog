-- v1.20.0 — classic Fitbit Web API (api.fitbit.com) authorises with PKCE
-- (Authorization Code + S256). Carry the per-handshake `code_verifier` from the
-- connect route to the callback on the short-lived OAuth-state ledger row.
--
-- Additive + nullable: a legacy in-flight row (or any non-PKCE path) simply
-- carries no verifier, so this is reversible and rerun-safe with no data loss.
-- `IF NOT EXISTS` guards a prod rerun.
ALTER TABLE "fitbit_oauth_states" ADD COLUMN IF NOT EXISTS "code_verifier" TEXT;
