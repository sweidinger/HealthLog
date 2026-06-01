-- v1.8.5 — user-level global injection-site exclusion.
--
-- A per-user deny-list of injection sites. Sites listed here are never
-- offered for ANY medication's injection-site picker, and the intake
-- write path rejects (422) a submitted site that lands on this list —
-- even when the per-medication `medications.allowed_injection_sites`
-- lists it as preferred. Deny always wins.
--
-- Typical use: a user develops lipohypertrophy at one site and wants it
-- excluded across every injectable they track, without editing each
-- medication's allowed list individually.
--
-- Single additive, defaulted enum-array column on `users`. Default
-- `'{}'` = no global exclusion (the pre-v1.8.5 behaviour). No backfill.
-- The `injection_site` enum type already exists (migration 0046).
--
-- Idempotent guard (`IF NOT EXISTS`) makes reruns safe.
--
-- Reversibility:
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "global_excluded_injection_sites";
-- A roll-back loses the global deny-list (every site becomes pickable
-- again, subject to each medication's own allowed list); the
-- application reads tolerate a missing column / default-empty value.
--
-- No index — reads are per-user at request time (`WHERE id = $1`),
-- matching `insights_exclude_metrics` and the other display-pref
-- columns on the same table.

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "global_excluded_injection_sites" "injection_site"[] NOT NULL DEFAULT ARRAY[]::"injection_site"[];
