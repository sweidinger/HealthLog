-- v1.11.0 — WHOOP integration (schema + data layer).
--
-- Purely-additive: two enum-extension batches, two new tables, and two new
-- nullable columns on `users`. No backfill, no existing row touched.
--
--   1. `measurement_type` += seven WHOOP-native score classes. WHOOP day-strain
--      lands in the NEW `DAY_STRAIN` (NOT the existing COMPUTED `STRAIN_SCORE`,
--      the v1.10.3 TRIMP engine) so the native value and the derived proxy
--      never share a bucket. The RMSSD HRV gets its own `HRV_RMSSD` for the
--      same reason (distinct estimator from the SDNN `HEART_RATE_VARIABILITY`).
--      WHOOP-native Recovery reuses the existing `RECOVERY_SCORE`, distinguished
--      only by `source = WHOOP` vs `COMPUTED`.
--   2. `measurement_source` += `WHOOP` for the server-side native ingest.
--   3. `whoop_connections` — per-user encrypted token row (1:1 with users),
--      mirroring `withings_connections` plus `whoop_user_id`,
--      `backfill_completed_at`, and `max_heart_rate`.
--   4. `whoop_oauth_states` — short-lived `(nonce → userId)` CSRF ledger,
--      identical in shape to `withings_oauth_states`.
--   5. `users` += `whoop_client_id_encrypted` / `whoop_client_secret_encrypted`
--      — per-user BYO-keys (the per-app authorized-user cap makes a single
--      shared WHOOP app unworkable for a multi-operator product).
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe. Forward-only.
--
-- Reversibility: Postgres cannot remove an enum value, so the eight new
-- members stay; with no rows carrying them they are inert. The two tables drop
-- with `DROP TABLE IF EXISTS`, the two columns with `DROP COLUMN IF EXISTS`.

-- ── 1. measurement_type — append the seven WHOOP-native score classes ──
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'HRV_RMSSD';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'DAY_STRAIN';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WORKOUT_STRAIN';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'SLEEP_PERFORMANCE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'SLEEP_EFFICIENCY';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'SLEEP_CONSISTENCY';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'SLEEP_NEED';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'ENERGY_EXPENDITURE_KJ';

-- ── 2. measurement_source — append the WHOOP server-owned source ───────
ALTER TYPE "measurement_source" ADD VALUE IF NOT EXISTS 'WHOOP';

-- ── 3. whoop_connections ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "whoop_connections" (
    "id"                    TEXT            NOT NULL,
    "user_id"               TEXT            NOT NULL,
    "whoop_user_id"         TEXT            NOT NULL,
    "access_token"          TEXT            NOT NULL,
    "refresh_token"         TEXT            NOT NULL,
    "token_expires_at"      TIMESTAMP(3)    NOT NULL,
    "scope"                 TEXT,
    "last_synced_at"        TIMESTAMP(3),
    "backfill_completed_at" TIMESTAMP(3),
    "max_heart_rate"        INTEGER,
    "created_at"            TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "whoop_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whoop_connections_user_id_key"
    ON "whoop_connections" ("user_id");

DO $$ BEGIN
    ALTER TABLE "whoop_connections"
        ADD CONSTRAINT "whoop_connections_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. whoop_oauth_states ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "whoop_oauth_states" (
    "nonce"      TEXT            NOT NULL,
    "user_id"    TEXT            NOT NULL,
    "created_at" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "whoop_oauth_states_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX IF NOT EXISTS "whoop_oauth_states_expires_at_idx"
    ON "whoop_oauth_states" ("expires_at");

DO $$ BEGIN
    ALTER TABLE "whoop_oauth_states"
        ADD CONSTRAINT "whoop_oauth_states_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ── 5. users — per-user WHOOP BYO-key columns (encrypted at app level) ─
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "whoop_client_id_encrypted" TEXT;
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "whoop_client_secret_encrypted" TEXT;
