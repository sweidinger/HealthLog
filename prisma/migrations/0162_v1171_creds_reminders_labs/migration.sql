-- v1.17.1 — schema foundation for per-user Polar/Oura BYO-app credentials,
-- preventive-care (Vorsorge) measurement reminders, a minimal structured lab
-- store, and the iOS Live Activity push-token channel (#22).
--
-- Purely-additive: four new nullable columns on `users` (encrypted client
-- credentials), one new nullable column on `devices`, and two new tables. No
-- backfill, no existing row touched, no enum change (Polar/Oura/Nightscout
-- measurement sources already landed in migration 0160).
--
--   1. `users` += Polar + Oura BYO-app client id/secret (encrypted at app
--      level, stored as TEXT), mirroring the WHOOP/Fitbit credential columns.
--   2. `devices` += `live_activity_push_token` for the iOS Live Activity
--      update/end APNs channel (#22). NULL when no active Live Activity.
--   3. `measurement_reminders` — preventive-care reminders. Cadence is a
--      rolling `interval_days` OR an RFC-5545 `rrule`; the recurrence engine
--      drives `next_due_at` (server-authoritative). Completion target is an
--      optional `measurement_type` (auto-resolve) or a free-text `label`.
--      Soft-deleted.
--   4. `lab_results` — one analyte per row, optional panel grouping + optional
--      reference range, optional encrypted note. Pairs with the Vorsorge
--      "annual blood panel" reminder so a result has somewhere to land.
--      Soft-deleted.
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe. Forward-only.
--
-- Reversibility: every column drops with `DROP COLUMN IF EXISTS`; both tables
-- drop with `DROP TABLE IF EXISTS`. No data is rewritten.

-- ── 1. users — Polar + Oura BYO-app client credentials (encrypted) ─────
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "polar_client_id_encrypted" TEXT;
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "polar_client_secret_encrypted" TEXT;
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "oura_client_id_encrypted" TEXT;
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "oura_client_secret_encrypted" TEXT;

-- ── 2. devices — iOS Live Activity push token (#22) ────────────────────
ALTER TABLE "devices"
    ADD COLUMN IF NOT EXISTS "live_activity_push_token" TEXT;

-- ── 3. measurement_reminders — preventive-care (Vorsorge) reminders ────
CREATE TABLE IF NOT EXISTS "measurement_reminders" (
    "id"                TEXT NOT NULL,
    "user_id"           TEXT NOT NULL,
    "label"             TEXT NOT NULL,
    "measurement_type"  "measurement_type",
    "interval_days"     INTEGER,
    "rrule"             TEXT,
    "anchor_date"       TIMESTAMP(3),
    "notify_hour"       INTEGER NOT NULL DEFAULT 9,
    "location"          TEXT,
    "next_due_at"       TIMESTAMP(3),
    "last_satisfied_at" TIMESTAMP(3),
    "enabled"           BOOLEAN NOT NULL DEFAULT true,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,
    "deleted_at"        TIMESTAMP(3),

    CONSTRAINT "measurement_reminders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "measurement_reminders_user_id_deleted_at_idx"
    ON "measurement_reminders" ("user_id", "deleted_at");
CREATE INDEX IF NOT EXISTS "measurement_reminders_user_id_next_due_at_idx"
    ON "measurement_reminders" ("user_id", "next_due_at");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'measurement_reminders_user_id_fkey'
    ) THEN
        ALTER TABLE "measurement_reminders"
            ADD CONSTRAINT "measurement_reminders_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users" ("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ── 4. lab_results — minimal structured lab store ──────────────────────
CREATE TABLE IF NOT EXISTS "lab_results" (
    "id"              TEXT NOT NULL,
    "user_id"         TEXT NOT NULL,
    "panel"           TEXT,
    "analyte"         TEXT NOT NULL,
    "value"           DOUBLE PRECISION NOT NULL,
    "unit"            TEXT NOT NULL,
    "reference_low"   DOUBLE PRECISION,
    "reference_high"  DOUBLE PRECISION,
    "taken_at"        TIMESTAMP(3) NOT NULL,
    "source"          TEXT NOT NULL DEFAULT 'MANUAL',
    "note_encrypted"  BYTEA,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,
    "deleted_at"      TIMESTAMP(3),

    CONSTRAINT "lab_results_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "lab_results_user_id_analyte_taken_at_idx"
    ON "lab_results" ("user_id", "analyte", "taken_at");
CREATE INDEX IF NOT EXISTS "lab_results_user_id_deleted_at_idx"
    ON "lab_results" ("user_id", "deleted_at");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'lab_results_user_id_fkey'
    ) THEN
        ALTER TABLE "lab_results"
            ADD CONSTRAINT "lab_results_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users" ("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
