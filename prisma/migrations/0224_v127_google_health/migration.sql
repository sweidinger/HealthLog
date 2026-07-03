-- v1.27.0 — Google Health API integration (Fitbit + Pixel Watch + Fitbit Air)
-- over `health.googleapis.com/v4` (schema + data layer).
--
-- A separate, coexisting provider alongside the classic Fitbit Web API
-- integration (0117) — its own connection table, `GOOGLE_HEALTH` source enum
-- value, and OAuth client. Purely-additive: one enum-extension, two new tables,
-- and two new nullable columns on `users`. No backfill, no existing row touched.
--
--   1. `measurement_source` += `GOOGLE_HEALTH` for the server-side native ingest.
--   2. `google_health_connections` — per-user encrypted token row (1:1 with
--      users), mirroring `fitbit_connections` plus a `needs_reauth` flag for the
--      Testing-mode 7-day refresh-expiry re-consent state.
--   3. `google_health_oauth_states` — short-lived `(nonce → userId)` CSRF
--      ledger with the PKCE `code_verifier`, identical in shape to
--      `fitbit_oauth_states`.
--   4. `users` += `google_health_client_id_encrypted` /
--      `google_health_client_secret_encrypted` — per-user BYO-keys (the CASA-free
--      "Testing" consent path caps a single OAuth client at ≤100 test users).
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe. Forward-only.
--
-- Reversibility: Postgres cannot remove an enum value, so `GOOGLE_HEALTH` stays;
-- with no rows carrying it it is inert. The two tables drop with `DROP TABLE IF
-- EXISTS`, the two columns with `DROP COLUMN IF EXISTS`.

-- ── 1. measurement_source — append the Google Health server-owned source ──
ALTER TYPE "measurement_source" ADD VALUE IF NOT EXISTS 'GOOGLE_HEALTH';

-- ── 2. google_health_connections ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "google_health_connections" (
    "id"                    TEXT            NOT NULL,
    "user_id"               TEXT            NOT NULL,
    "google_user_id"        TEXT            NOT NULL,
    "access_token"          TEXT            NOT NULL,
    "refresh_token"         TEXT            NOT NULL,
    "token_expires_at"      TIMESTAMP(3)    NOT NULL,
    "scope"                 TEXT,
    "needs_reauth"          BOOLEAN         NOT NULL DEFAULT false,
    "last_synced_at"        TIMESTAMP(3),
    "backfill_completed_at" TIMESTAMP(3),
    "created_at"            TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "google_health_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "google_health_connections_user_id_key"
    ON "google_health_connections" ("user_id");

DO $$ BEGIN
    ALTER TABLE "google_health_connections"
        ADD CONSTRAINT "google_health_connections_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. google_health_oauth_states ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "google_health_oauth_states" (
    "nonce"         TEXT            NOT NULL,
    "user_id"       TEXT            NOT NULL,
    "code_verifier" TEXT,
    "created_at"    TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"    TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "google_health_oauth_states_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX IF NOT EXISTS "google_health_oauth_states_expires_at_idx"
    ON "google_health_oauth_states" ("expires_at");

DO $$ BEGIN
    ALTER TABLE "google_health_oauth_states"
        ADD CONSTRAINT "google_health_oauth_states_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. users — per-user Google Health BYO-key columns (encrypted at app level) ─
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "google_health_client_id_encrypted" TEXT;
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "google_health_client_secret_encrypted" TEXT;
