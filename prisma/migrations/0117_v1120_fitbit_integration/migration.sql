-- v1.12.0 — Fitbit/Pixel integration via the Google Health API (schema + data
-- layer).
--
-- Purely-additive: one enum-extension, two new tables, and two new nullable
-- columns on `users`. No backfill, no existing row touched. Unlike the WHOOP
-- migration (0111) this adds NO new `measurement_type` values — every Fitbit
-- launch metric maps onto an existing type.
--
--   1. `measurement_source` += `FITBIT` for the server-side native ingest.
--   2. `fitbit_connections` — per-user encrypted token row (1:1 with users),
--      mirroring `whoop_connections` minus `max_heart_rate`, plus
--      `fitbit_user_id` and `backfill_completed_at`.
--   3. `fitbit_oauth_states` — short-lived `(nonce → userId)` CSRF ledger,
--      identical in shape to `whoop_oauth_states`.
--   4. `users` += `fitbit_client_id_encrypted` / `fitbit_client_secret_encrypted`
--      — per-user BYO-keys (Google's Testing-mode per-app authorized-user cap
--      makes a single shared client unworkable for a multi-operator product).
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe. Forward-only.
--
-- Reversibility: Postgres cannot remove an enum value, so `FITBIT` stays; with
-- no rows carrying it it is inert. The two tables drop with `DROP TABLE IF
-- EXISTS`, the two columns with `DROP COLUMN IF EXISTS`.

-- ── 1. measurement_source — append the Fitbit server-owned source ──────
ALTER TYPE "measurement_source" ADD VALUE IF NOT EXISTS 'FITBIT';

-- ── 2. fitbit_connections ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "fitbit_connections" (
    "id"                    TEXT            NOT NULL,
    "user_id"               TEXT            NOT NULL,
    "fitbit_user_id"        TEXT            NOT NULL,
    "access_token"          TEXT            NOT NULL,
    "refresh_token"         TEXT            NOT NULL,
    "token_expires_at"      TIMESTAMP(3)    NOT NULL,
    "scope"                 TEXT,
    "last_synced_at"        TIMESTAMP(3),
    "backfill_completed_at" TIMESTAMP(3),
    "created_at"            TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "fitbit_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "fitbit_connections_user_id_key"
    ON "fitbit_connections" ("user_id");

DO $$ BEGIN
    ALTER TABLE "fitbit_connections"
        ADD CONSTRAINT "fitbit_connections_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. fitbit_oauth_states ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "fitbit_oauth_states" (
    "nonce"      TEXT            NOT NULL,
    "user_id"    TEXT            NOT NULL,
    "created_at" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "fitbit_oauth_states_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX IF NOT EXISTS "fitbit_oauth_states_expires_at_idx"
    ON "fitbit_oauth_states" ("expires_at");

DO $$ BEGIN
    ALTER TABLE "fitbit_oauth_states"
        ADD CONSTRAINT "fitbit_oauth_states_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. users — per-user Fitbit BYO-key columns (encrypted at app level) ─
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "fitbit_client_id_encrypted" TEXT;
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "fitbit_client_secret_encrypted" TEXT;
