-- v1.12.0 — deepen the structured mood-tag taxonomy.
--
-- Purely additive on top of migration 0101's catalog: one new `hobbies`
-- category (movies / reading / gaming / music / outdoors) plus a set of
-- nutrition-detail tags appended to the existing `health` category
-- (`fast_food` / `no_sweets` / `big_meal`, alongside the original
-- `ate_well`). No table changes, no per-user data touched — this only
-- seeds new global catalog rows.
--
-- `label_key` columns carry an i18n message key (resolved client-side
-- against all six locales), same convention as the original seed. The
-- inserts use deterministic ids + ON CONFLICT upsert by `key` so a
-- re-run is idempotent, mirroring 0101 exactly.

-- ─── New category: hobbies ───────────────────────────────────────────
INSERT INTO "mood_tag_categories" ("id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mtc_hobbies', 'hobbies', 'mood.tagCategory.hobbies', 'Palette', 5, true)
ON CONFLICT ("key") DO UPDATE SET
  "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_movies', 'mtc_hobbies', 'movies', 'mood.tag.movies', 'Film', 0, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_reading', 'mtc_hobbies', 'reading', 'mood.tag.reading', 'BookOpen', 1, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_gaming', 'mtc_hobbies', 'gaming', 'mood.tag.gaming', 'Gamepad2', 2, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_music', 'mtc_hobbies', 'music', 'mood.tag.music', 'Music', 3, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_outdoors', 'mtc_hobbies', 'outdoors', 'mood.tag.outdoors', 'Trees', 4, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

-- ─── Nutrition-detail tags appended to the existing `health` category ─
-- Mirrors the existing `ate_well` (sort_order 1) under `mtc_health`; the
-- original health tags occupy sort_order 0-4, so these slot in at 5-7.
INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_fast_food', 'mtc_health', 'fast_food', 'mood.tag.fastFood', 'Pizza', 5, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_no_sweets', 'mtc_health', 'no_sweets', 'mood.tag.noSweets', 'CandyOff', 6, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_big_meal', 'mtc_health', 'big_meal', 'mood.tag.bigMeal', 'UtensilsCrossed', 7, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";
