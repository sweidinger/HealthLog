-- v1.10.3 — Strain personal-anchor cache.
--
-- A server-internal per-(user, day) cache that lets the nightly Strain engine
-- anchor the 0–100 map to the user's OWN recent training-day load (an
-- EWMA-smoothed P75 of day-total TRIMP over a 42-day chronic window) instead
-- of the fixed population reference. Persisting the day-total TRIMP + the
-- running EWMA reference means the chronic window reads cheap cached values
-- rather than re-integrating 42 days of HR series every night.
--
-- Purely additive: one new table, no enum changes, no backfill. The nightly
-- idempotent recompute populates the cache forward; until a user accrues
-- enough personal training history the engine falls back to the population
-- anchor, so behaviour matches today until the cache fills in — a clean,
-- self-healing rollout.
--
-- NOT a Measurement: never read through the derived registry, never on a
-- user-facing surface, never in the doctor PDF or FHIR bundle, never ingested
-- from a client. A dedicated table keeps it server-internal and out of every
-- MeasurementType completeness wall.
--
-- Reversibility: forward-only; dropping the table loses only the cache, and
-- the nightly job rebuilds it (falling back to the population anchor in the
-- interim).

CREATE TABLE IF NOT EXISTS "strain_trimp_cache" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "day_trimp" DOUBLE PRECISION NOT NULL,
    "ref_personal" DOUBLE PRECISION NOT NULL,
    "anchor" TEXT NOT NULL,
    "training_days" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strain_trimp_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "strain_trimp_cache_user_id_day_key"
    ON "strain_trimp_cache" ("user_id", "day");

CREATE INDEX IF NOT EXISTS "strain_trimp_cache_user_id_day_idx"
    ON "strain_trimp_cache" ("user_id", "day" DESC);

ALTER TABLE "strain_trimp_cache"
    ADD CONSTRAINT "strain_trimp_cache_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
