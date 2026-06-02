-- v1.10.0 — computed scores (WX-C): COMPUTED source + the three `*_SCORE`
-- measurement types.
--
-- Two purely-additive enum extensions, no new columns and no backfill:
--
--   1. A new `measurement_source` value `COMPUTED` for server-derived rows.
--      A `COMPUTED` Measurement is minted by a nightly engine from the user's
--      already-stored signals (the Recovery score is the first); it is NEVER
--      ingested from a client. The client-facing batch + single-POST write
--      surfaces reject it exactly like `WITHINGS` / `IMPORT`. It is part of
--      the enum so the read/response shapes (and the iOS decoder) can decode
--      the rows it surfaces.
--
--   2. Three new `measurement_type` values — the server-derived wellness
--      scores `RECOVERY_SCORE`, `STRESS_SCORE`, `STRAIN_SCORE` (0–100, unit
--      `score`), each minted nightly by its own engine. These are NOT
--      clinical vitals: they stay out of the clinical vitals table and
--      surface only in a clearly-labelled, descriptive-not-clinical wellness
--      summary (and as FHIR `survey`-category observations).
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe. Forward-only.
--
-- Reversibility:
--   Postgres does not support removing an enum value, so the four new
--   members stay; with no rows carrying them (a `COMPUTED` source / a
--   `*_SCORE` type) after the nightly job is disabled they are inert.

-- ── 1. measurement_source — append the COMPUTED server-owned source ────
-- Pure additive; no existing row carries this value. The `IF NOT EXISTS`
-- guard keeps the migration idempotent across a partially-applied environment.
ALTER TYPE "measurement_source" ADD VALUE IF NOT EXISTS 'COMPUTED';

-- ── 2. measurement_type — append the three computed-score classes ──────
-- Pure additive; no existing row carries any of these values.
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'RECOVERY_SCORE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'STRESS_SCORE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'STRAIN_SCORE';
