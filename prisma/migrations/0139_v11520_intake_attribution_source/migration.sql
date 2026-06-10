-- v1.15.20 — provenance of an intake row's slot binding.
--
-- An off-window take can now be deliberately pinned onto a scheduled slot
-- ("diesem Slot zuordnen"). The column records HOW the row's `scheduled_for`
-- binding came to be: AUTO = window-band attribution (or a skip / pending
-- mint anchored on its slot), USER_PIN = a deliberate user pin. The read
-- ledger binds USER_PIN rows by their stored anchor (like skips) instead of
-- re-running takenAt-band attribution, so a pinned take outside the late
-- tail stays on its slot — rendered taken-late, never on-time-washed.
--
-- Additive + non-destructive: a new NOT NULL column with a default, no
-- backfill needed. Existing rows read AUTO.
CREATE TYPE "intake_attribution_source" AS ENUM ('AUTO', 'USER_PIN');

ALTER TABLE "medication_intake_events"
  ADD COLUMN "attribution_source" "intake_attribution_source" NOT NULL DEFAULT 'AUTO';
