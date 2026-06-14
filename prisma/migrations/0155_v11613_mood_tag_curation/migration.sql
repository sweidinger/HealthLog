-- v1.16.13 — operator mood-tag catalog curation.
--
-- Reference-data only on top of 0101 / 0118 / 0119 / 0126. No schema
-- change, no per-user data touched, no destructive delete — every change
-- is an `is_active` flip or an idempotent upsert keyed by `key`, so a
-- re-run is a no-op and historical `mood_entry_tag_links` rows keep
-- resolving their labels (the insights read joins the catalog row by id
-- and does NOT filter `is_active`).
--
-- Operator walked the capture sheet and asked for:
--   - deactivate the redundant default tags `happy`, `excited`,
--     `hydrated` ("Wasser getrunken") and `music`;
--   - keep `overtime` active — 0126 had deactivated it as a low-signal
--     day-type tag, but the operator wants it back in the work picker;
--   - add a new default tag `praise` ("Lob" / "Praise") under the work
--     category, Lucide `ThumbsUp` (already in the iOS Lucide→SF table).
--
-- factor_sleep_quality is deliberately LEFT untouched: the curation note
-- premised its removal on a dedicated sleep-quality slider elsewhere, but
-- no such slider exists in the capture surface. It stays one of the three
-- surviving RATED factors (work / sleep quality / sadness) seeded by 0126.

-- ─── Deactivate the four redundant default tags ──────────────────────
UPDATE "mood_tags"
SET "is_active" = false
WHERE "key" IN ('happy', 'excited', 'hydrated', 'music');

-- ─── Re-activate overtime in the work category ───────────────────────
UPDATE "mood_tags"
SET "is_active" = true
WHERE "key" = 'overtime';

-- ─── New default tag: praise (work) ──────────────────────────────────
-- Sort after the existing work tags (productive 0, overtime 1, day_off 2,
-- travel 3, sick_day 4). ThumbsUp keeps the iOS render native (no app
-- update needed). Idempotent upsert by `key`, mirroring 0101 / 0118.
INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_praise', 'mtc_work', 'praise', 'mood.tag.praise', 'ThumbsUp', 5, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order", "is_active" = EXCLUDED."is_active";
