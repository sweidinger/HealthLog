-- v1.11.0 — period-narrative cache (Pillar P1).
--
-- One durable, typed row per (user, period, locale) holding the latest
-- generated period summary ("how your week/month went"). Delete +
-- regenerate clean: the unique index on (user_id, period, locale) enforces
-- a single row per slot, so a regeneration upserts in place and there is
-- never a stale duplicate to disambiguate.
--
-- The generated prose is held AES-256-GCM at rest in `encrypted_content`
-- (BYTEA), following the `coach_messages.encrypted_content` precedent. The
-- `provenance_json` envelope is labels-only (metric names, the read window,
-- the FDR footer) and carries no PII, so it stays plaintext for a stable,
-- queryable shape — matching `coach_messages.metric_source_json`.
--
-- Purely additive: one new table, no enum changes, no backfill. Deleting the
-- user cascades every narrative away (clean GDPR-erasure).

CREATE TABLE IF NOT EXISTS "insight_narratives" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "date_key" TEXT NOT NULL,
    "encrypted_content" BYTEA NOT NULL,
    "provenance_json" TEXT,
    "provider_type" TEXT,
    "prompt_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insight_narratives_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "insight_narratives_user_id_period_locale_key"
    ON "insight_narratives" ("user_id", "period", "locale");

CREATE INDEX IF NOT EXISTS "insight_narratives_user_id_updated_at_idx"
    ON "insight_narratives" ("user_id", "updated_at" DESC);

ALTER TABLE "insight_narratives"
    ADD CONSTRAINT "insight_narratives_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
