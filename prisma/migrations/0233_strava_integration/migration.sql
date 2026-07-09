-- v1.28.x — Strava OAuth integration (schema + data layer).
--
-- Strava is a per-user BYO-OAuth workout source, mirroring WHOOP/Oura/Polar:
-- Strava caps every newly-created API app at single-player mode (athlete
-- capacity 1), so a single shared app cannot serve many self-hosters — each
-- registers their own Strava app and pastes the client id/secret into Settings.
-- Strava feeds `Workout` rows only (it exposes no sleep / recovery / body
-- metrics) and rotates its refresh token on every refresh, so it follows Oura's
-- reactive-refresh + compare-and-set token model (tokens live on `users`, no
-- token-expiry column).
--
--   1. `measurement_source` += `STRAVA` for the server-side native ingest.
--   2. `users` += the encrypted BYO-app credentials + granted tokens, the
--      plaintext athlete id, the incremental-sync cursor, and the backfill
--      marker. Purely-additive: nullable columns, no backfill, no row touched.
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe. Forward-only.
--
-- Reversibility: Postgres cannot remove an enum value, so `STRAVA` stays; with
-- no rows carrying it it is inert. The columns drop with `DROP COLUMN IF EXISTS`.

-- ── 1. measurement_source — append the Strava server-owned source ──────
ALTER TYPE "measurement_source" ADD VALUE IF NOT EXISTS 'STRAVA';

-- ── 2. users — per-user Strava credentials, tokens, cursor, backfill marker ──
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "strava_client_id_encrypted"      TEXT,
    ADD COLUMN IF NOT EXISTS "strava_client_secret_encrypted"  TEXT,
    ADD COLUMN IF NOT EXISTS "strava_access_token_encrypted"   TEXT,
    ADD COLUMN IF NOT EXISTS "strava_refresh_token_encrypted"  TEXT,
    ADD COLUMN IF NOT EXISTS "strava_athlete_id"               TEXT,
    ADD COLUMN IF NOT EXISTS "strava_last_activity_at"         TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "strava_backfill_completed_at"    TIMESTAMP(3);
