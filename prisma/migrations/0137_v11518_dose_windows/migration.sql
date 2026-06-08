-- v1.15.18 — per-dose configurable intake WINDOW.
--
-- Marc's "07:00–09:00" lever: a dose time can carry an explicit on-time RANGE
-- instead of the symmetric ±1h default the band minter derives. The column is
-- a nullable JSON array of `{ timeOfDay, start, end }` HH:mm triples, one per
-- dose time the user gave an explicit window for, e.g.
--   [{ "timeOfDay": "07:00", "start": "07:00", "end": "09:00" }]
--
-- The band minter reads it to build the on-time band from `[start, end]` for
-- the matching `timeOfDay`; a time with no entry keeps the default ±1h
-- derivation, and a NULL column leaves every slot on the default (unchanged
-- behaviour). The late tail stays cadence-derived.
--
-- Additive + non-destructive: a new nullable column with no backfill. Existing
-- rows read NULL and behave exactly as before; the iOS contract gains an
-- optional field.
ALTER TABLE "medication_schedules"
  ADD COLUMN "dose_windows" JSONB;
