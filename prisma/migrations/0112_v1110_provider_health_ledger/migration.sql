-- v1.11.0 W1 — durable, multi-instance provider-health ledger.
--
-- Promotes the volatile per-worker last-working cache in
-- `provider-runner.ts` to Postgres, modelled on the atomic-upsert
-- rate-limiter table so every worker shares one health signal. One row
-- per (user, provider chain entry):
--   - the runner records each generation outcome (ok / hard_failed /
--     auth_failed) and reads the row to deprioritise or skip a provider
--     inside its backoff window instead of re-burning a dead round-trip;
--   - an auth-class failure (401/403) sets `last_result = 'auth_failed'`
--     plus a `next_retry_at` cooldown — a durable negative cache that
--     also drives the proactive `credential_expired` surfacing.
--
-- Purely additive: one new table, no enum changes, no backfill. Until a
-- provider fails the table is empty and behaviour matches today.
-- Reversibility: forward-only; dropping the table loses only the cache,
-- and the runner repopulates it on the next outcome.

CREATE TABLE IF NOT EXISTS "provider_health" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider_type" TEXT NOT NULL,
    "last_result" TEXT NOT NULL,
    "last_status" INTEGER,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_ok_at" TIMESTAMP(3),
    "last_failure_at" TIMESTAMP(3),
    "next_retry_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_health_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "provider_health_user_id_provider_type_key"
    ON "provider_health" ("user_id", "provider_type");

CREATE INDEX IF NOT EXISTS "provider_health_user_id_last_result_idx"
    ON "provider_health" ("user_id", "last_result");

ALTER TABLE "provider_health"
    ADD CONSTRAINT "provider_health_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
