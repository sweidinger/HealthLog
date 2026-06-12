-- v1.16.11 (#316) — as-needed (PRN) medications.
--
-- `as_needed = true` marks a medication taken only when the user needs
-- it: no fixed schedule (zero medication_schedules rows — enforced at
-- the route layer), never due, never reminded, excluded from
-- compliance, active indefinitely. Intakes still log, inventory still
-- consumes. Additive: every existing row backfills `false`.

ALTER TABLE "medications" ADD COLUMN "as_needed" BOOLEAN NOT NULL DEFAULT false;
