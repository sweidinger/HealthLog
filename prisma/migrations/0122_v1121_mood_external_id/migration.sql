-- v1.12.1 — stable external dedup key for MoodEntry.
--
-- Problem. Unlike `Measurement`, `MoodEntry` carries no `external_id`.
-- The moodLog webhook + pull sync + JSON import all upsert/insert on
-- `(user_id, date, mood_logged_at)`. If the upstream re-emits the same
-- entry with a re-rounded or re-zoned `mood_logged_at` (a Daylio export
-- re-import, or a tz change moving `date`), the composite key differs
-- and a SECOND row lands for the same physical mood entry. Measurements
-- solved exactly this with `external_id`; mood did not.
--
-- Fix. Add a nullable `external_id` column + a NULL-DISTINCT unique on
-- `(user_id, source, external_id)`. Postgres treats NULLs as distinct in
-- a unique index by default, so every MANUAL/native entry (which carries
-- a NULL `external_id`) never collides on the new key and keeps the
-- legacy `(user_id, date, mood_logged_at)` path. Importers that receive
-- a source-stable id (the moodLog upstream entry id, a Daylio row id)
-- write it into `external_id` and upsert on the new key, making a
-- re-import idempotent regardless of `mood_logged_at` drift.
--
-- Strictly additive: a new nullable column + a NULL-distinct unique
-- index. No backfill (legacy rows stay NULL → distinct → untouched), no
-- rewrite of `mood_entries`.

ALTER TABLE "mood_entries"
  ADD COLUMN IF NOT EXISTS "external_id" TEXT;

-- NULL-distinct unique: only entries that carry a real source id are
-- constrained; the long tail of native/MANUAL rows (NULL external_id)
-- never collides here.
CREATE UNIQUE INDEX IF NOT EXISTS "mood_entries_user_id_source_external_id_key"
  ON "mood_entries" ("user_id", "source", "external_id");
