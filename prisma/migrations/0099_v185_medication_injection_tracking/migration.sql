-- v1.8.5 — per-medication injection-site tracking.
--
-- Makes injection-site tracking + rotation real. Prior to this release
-- the `injection_site` column on `medication_intake_events` was read in
-- several surfaces but never written; tracking was effectively dead.
--
-- Two additive, defaulted columns on `medications`:
--
--   - `track_injection_sites` — per-medication opt-in. Only meaningful
--     (and only offered in the UI) when `delivery_form = 'INJECTION'`.
--     Default false: the post-dose site prompt fires only when this is
--     true, and the prompt is always skippable. Deactivatable any time.
--
--   - `allowed_injection_sites` — per-medication allowed / preferred
--     sites. Empty = no per-medication restriction (every site offered).
--     The effective pickable set is this list MINUS the user-level
--     `users.global_excluded_injection_sites` deny-list (deny wins). The
--     intake write path validates a submitted site against the effective
--     set and rejects (422) a disallowed value.
--
-- Both columns are additive + defaulted; no backfill is required. The
-- `injection_site` enum type already exists (migration 0046).
--
-- Idempotent guards (`IF NOT EXISTS`) make reruns safe.
--
-- Reversibility:
--   ALTER TABLE "medications" DROP COLUMN IF EXISTS "track_injection_sites";
--   ALTER TABLE "medications" DROP COLUMN IF EXISTS "allowed_injection_sites";
-- A roll-back loses the opt-in flag + the per-medication site list; the
-- application reads tolerate a missing column / default-empty value.

ALTER TABLE "medications"
    ADD COLUMN IF NOT EXISTS "track_injection_sites" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "allowed_injection_sites" "injection_site"[] NOT NULL DEFAULT ARRAY[]::"injection_site"[];
