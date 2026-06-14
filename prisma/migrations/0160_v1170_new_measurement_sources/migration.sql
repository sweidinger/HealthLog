-- v1.17.0 — schema foundation for three new measurement sources: Nightscout
-- glucose (F1) and Polar + Oura OAuth wearables (F4).
--
-- Purely-additive: three enum-extensions on `measurement_source` plus eight
-- new nullable columns on `users` (encrypted credentials + one boolean flag).
-- No backfill, no existing row touched, no new tables. The feature waves add
-- their own connection / oauth-state tables later; this step only unblocks
-- them from colliding on the enum + the credential surface.
--
--   1. `measurement_source` += `NIGHTSCOUT`, `POLAR`, `OURA` for the
--      server-side native ingest of each source.
--   2. `users` += Nightscout base URL + token (encrypted) + an
--      `allow_private_host` opt-in boolean (default false) that lets a
--      self-hoster point HealthLog at a private/LAN Nightscout instance past
--      the public-host SSRF floor.
--   3. `users` += Polar OAuth credentials (access / refresh token + user id),
--      encrypted, mirroring the WHOOP credential columns.
--   4. `users` += Oura OAuth credentials (access / refresh token), encrypted,
--      mirroring the WHOOP credential columns.
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe. Forward-only.
--
-- Reversibility: Postgres cannot remove an enum value, so the three sources
-- stay; with no rows carrying them they are inert. The columns drop with
-- `DROP COLUMN IF EXISTS`.

-- ── 1. measurement_source — append the three server-owned sources ──────
ALTER TYPE "measurement_source" ADD VALUE IF NOT EXISTS 'NIGHTSCOUT';
ALTER TYPE "measurement_source" ADD VALUE IF NOT EXISTS 'POLAR';
ALTER TYPE "measurement_source" ADD VALUE IF NOT EXISTS 'OURA';

-- ── 2. users — Nightscout credentials + private-host opt-in ────────────
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "nightscout_url_encrypted" TEXT;
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "nightscout_token_encrypted" TEXT;
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "nightscout_allow_private_host" BOOLEAN NOT NULL DEFAULT false;

-- ── 3. users — Polar OAuth credentials (encrypted at app level) ────────
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "polar_access_token_encrypted" TEXT;
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "polar_user_id_encrypted" TEXT;

-- ── 4. users — Oura OAuth credentials (encrypted at app level) ─────────
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "oura_access_token_encrypted" TEXT;
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "oura_refresh_token_encrypted" TEXT;
