-- v1.16.4 — per-intake dose override.
--
-- A user who takes half a tablet (or a doubled dose on a titration day)
-- could only record the take as-is; the ledger then implied the scheduled
-- dose was consumed. `dose_taken` records the free-text dose actually
-- consumed for THIS event when it deviates from (or simply documents) the
-- medication / schedule dose. NULL = no override recorded — every legacy
-- row and every take logged without touching the dose field stays NULL,
-- and read paths fall back to the medication's configured dose.
ALTER TABLE "medication_intake_events" ADD COLUMN "dose_taken" TEXT;
