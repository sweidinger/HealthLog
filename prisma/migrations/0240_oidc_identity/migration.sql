-- v1.28 — OIDC SSO identity pinning.
--
-- The (oidc_issuer, oidc_sub) pair pins an account to exactly one IdP
-- identity: stamped on first OIDC login (auto-provision or one-time link by
-- verified email), matched on every later OIDC login. Email stays a display
-- field after the stamp — an IdP-side email change can never re-point the
-- login at a different account. Both columns are NULL on accounts that never
-- signed in via SSO; Postgres unique indexes ignore NULL pairs, so the
-- constraint only bites on actual duplicate identities.
ALTER TABLE "users" ADD COLUMN "oidc_issuer" TEXT;
ALTER TABLE "users" ADD COLUMN "oidc_sub" TEXT;

CREATE UNIQUE INDEX "users_oidc_issuer_oidc_sub_key" ON "users"("oidc_issuer", "oidc_sub");
