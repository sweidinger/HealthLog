-- v1.21.0 — per-user date display preference.
--
-- The UI locale alone decided whether dates rendered as dd.MM.yyyy or
-- MM/dd/yyyy, and the native date input fell back to the browser locale,
-- which left non-US self-hosters on MM/DD/YYYY with no way out. The new
-- column carries an explicit preference: AUTO follows the locale
-- convention, DMY pins day-month-year, MDY pins month-day-year, YMD pins
-- ISO yyyy-MM-dd. Display-time only — stored instants stay UTC.
--
-- Additive + non-destructive: a new NOT NULL column with a default, no
-- backfill needed. Existing rows read AUTO. Guarded so a re-run is a
-- no-op (the enum create + the column add both skip when present).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'date_format_preference'
  ) THEN
    CREATE TYPE "date_format_preference" AS ENUM ('AUTO', 'DMY', 'MDY', 'YMD');
  END IF;
END
$$;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "date_format" "date_format_preference" NOT NULL DEFAULT 'AUTO';
