-- v1.4.15 Phase B6: doctor-report v2 — practice / clinic name preference.
--
-- The doctor-report cover used to be impersonal: title, subtitle, separator.
-- Marc asked for the addressee (his GP's practice name) to be visible at
-- first glance so the printout doubles as an opening line ("Praxis Dr. X —
-- here is what I tracked since the last visit").
--
-- We persist the most-recent value the user typed into the export dialog
-- so the input is pre-filled next time. Stored as a plain TEXT column —
-- this is not PII a third party would care about and the user already has
-- write-access to it, but the field is sanitised + length-capped upstream
-- (`sanitisePracticeName()` in `src/lib/doctor-report-data.ts`) before any
-- value lands here.
--
-- The migration is a no-op for existing rows: the column is nullable with
-- no default; users who never open the doctor-report keep `NULL` and the
-- cover line is omitted entirely.

ALTER TABLE "users"
  ADD COLUMN "last_report_practice_name" TEXT;
