-- v1.15.20 — per-user hour-cycle display preference.
--
-- The UI locale alone decided whether times rendered as AM/PM or 24-hour,
-- which left e.g. an en-locale user no way to read 24-hour times. The new
-- column carries an explicit preference: AUTO follows the locale convention,
-- H12 forces AM/PM, H24 forces 24-hour. Display-time only — stored instants
-- stay UTC.
--
-- Additive + non-destructive: a new NOT NULL column with a default, no
-- backfill needed. Existing rows read AUTO.
CREATE TYPE "time_format_preference" AS ENUM ('AUTO', 'H12', 'H24');

ALTER TABLE "users"
  ADD COLUMN "time_format" "time_format_preference" NOT NULL DEFAULT 'AUTO';
