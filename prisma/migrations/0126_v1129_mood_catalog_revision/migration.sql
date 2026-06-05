-- v1.12.9 — mood-catalog revision.
--
-- Tightens the operator-finalised mood factor + tag catalog seeded by
-- 0118 / 0119 / 0120. Three changes, all reference-data only — no schema
-- change, no per-user data touched, no destructive delete:
--
--   1. Seed a new RATED factor `factor_sadness` (scale 1..5, inverse —
--      higher = a worse day), under the existing `factors` category.
--   2. Retire the four RATED factors the operator dropped
--      (`factor_conflict`, `factor_family`, `factor_social`,
--      `factor_stress`): flip each to `kind = 'BINARY'` AND set
--      `is_active = false`. They leave the RATED set and the default
--      picker, but the catalog rows stay so any historical
--      `mood_entry_tag_links` row still resolves its label (the insights
--      read joins the catalog row by id and does NOT filter `is_active`).
--      The result: exactly THREE RATED factors remain
--      (`factor_work`, `factor_sleep_quality`, `factor_sadness`).
--   3. Trim the default BINARY tag set roughly in half: mark the
--      long-tail / slider-redundant tags `is_active = false`. The picker
--      (`GET /api/mood/tags` filters `is_active = true`) stops offering
--      them; existing entries that reference a now-inactive tag still
--      resolve its label because the read joins by id without the active
--      filter. Nothing is deleted.
--
-- Idempotent: the seed uses a deterministic id + ON CONFLICT upsert by
-- `key` (mirrors 0118 / 0119 / 0120); the retire / trim updates key off a
-- closed `key` list, so a re-run is a no-op.

-- ─── 1. New RATED factor: sadness (inverse, 1..5) ────────────────────
INSERT INTO "mood_tags"
  ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active", "kind", "scale_min", "scale_max", "inverse")
VALUES ('mt_factor_sadness', 'mtc_factors', 'factor_sadness', 'mood.tag.factorSadness', 'CloudRain', 2, true, 'RATED', 1, 5, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order", "is_active" = EXCLUDED."is_active", "kind" = EXCLUDED."kind",
  "scale_min" = EXCLUDED."scale_min", "scale_max" = EXCLUDED."scale_max", "inverse" = EXCLUDED."inverse";

-- Re-seat the two surviving RATED factors at the top of the `factors`
-- category so the final order reads work → sleep quality → sadness.
UPDATE "mood_tags" SET "sort_order" = 0 WHERE "key" = 'factor_work';
UPDATE "mood_tags" SET "sort_order" = 1 WHERE "key" = 'factor_sleep_quality';

-- ─── 2. Retire the four dropped RATED factors (BINARY + inactive) ─────
-- Flip kind so they leave the RATED set; deactivate so they leave the
-- default picker. Historical RATED links keep their `rating` value and
-- still resolve their label (read joins the catalog row by id, no active
-- filter). Not deleted — references stay valid.
UPDATE "mood_tags"
SET "kind" = 'BINARY', "is_active" = false
WHERE "key" IN ('factor_conflict', 'factor_family', 'factor_social', 'factor_stress');

-- ─── 3. Trim the default BINARY tag set (~half) ──────────────────────
-- Deactivate the long-tail / slider-redundant binary tags. Kept set is
-- the high-signal, plausibly-correlatable tags; dropped set is sleep
-- tags now covered by the Schlafqualität slider, mood-level restatements
-- (the 1..5 face already carries them), and low-signal duplicates. Rows
-- stay so historical entries still resolve their labels.
UPDATE "mood_tags"
SET "is_active" = false
WHERE "key" IN (
  -- feelings: drop tags that just restate the 5-face mood level / overlap
  -- the surviving factor_sadness; keep a tight high-signal subset.
  'content', 'unsure', 'bored', 'tense', 'stressed', 'sad',
  -- sleep: the Schlafqualität (factor_sleep_quality) slider supersedes
  -- the whole sleep-tag category.
  'slept_well', 'slept_ok', 'slept_poorly', 'early_night',
  -- health: drop the nutrition long-tail (kept: ate_well, alcohol,
  -- worked_out, walked, hydrated).
  'fast_food', 'no_sweets', 'big_meal',
  -- work: drop low-signal day-type tags (kept: productive, day_off).
  'overtime', 'travel', 'sick_day'
);
