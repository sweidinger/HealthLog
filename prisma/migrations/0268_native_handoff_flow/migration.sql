-- v1.32.11 — native web-handoff login (iOS #65).
--
-- The `oidc_native_handoffs` table now backs two flows: the original OIDC SSO
-- native leg and the first-party web-handoff login a self-hoster's iOS app runs
-- against its own domain. Both mint the same single-use, PKCE-locked, hashed-at-
-- rest handoff code through the shared core; the `flow` column records which
-- flow minted a row so the consume path can refuse a cross-flow redemption
-- (an `oidc` code presented at the web-login token route, or vice versa).
--
-- Additive and backfill-safe: every existing row is an OIDC handoff, so the
-- column defaults to 'oidc' and no data migration is needed.

ALTER TABLE "oidc_native_handoffs"
  ADD COLUMN "flow" TEXT NOT NULL DEFAULT 'oidc';
