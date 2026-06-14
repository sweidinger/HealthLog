-- v1.17.0 — disturbed-temperature exclusion for the symptothermal engine.
--
-- A fever / illness / alcohol / late or short-sleep BBT reading can fake or
-- mask a temperature rise. `temperature_excluded = true` marks a day's basal
-- body temperature as a disturbed value: the Sensiplan cover-line baseline and
-- the shift evaluation both skip it, so a spike neither fabricates nor masks a
-- rise (the cover line is drawn over the last six *unbracketed* values).
-- Additive: every existing row backfills `false`.

ALTER TABLE "cycle_day_logs" ADD COLUMN "temperature_excluded" BOOLEAN NOT NULL DEFAULT false;
