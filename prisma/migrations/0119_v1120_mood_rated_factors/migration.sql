-- v1.12.0 — rated mood factors (ingestion half).
--
-- Additive on top of the binary mood-tag taxonomy (0101 / 0118). A rated
-- factor is a `MoodTag` whose `kind = 'RATED'`: the user scores it 1..5
-- (or the tag's own scale) per entry, and the score rides on the existing
-- `mood_entry_tag_links` join via a new `rating` column. Binary tags keep
-- `kind = 'BINARY'` and `rating = NULL`, so every pre-existing row and
-- read path stays byte-identical.
--
-- Two `ALTER TABLE ADD COLUMN` blocks (all NOT NULL with a default, or
-- nullable) keep this strictly additive — no backfill, no rewrite. Then
-- seed the five MVP rated factors under a new `factors` category. The
-- inserts use deterministic ids + ON CONFLICT upsert by `key` so a re-run
-- is idempotent, mirroring 0101 / 0118 exactly. The seed only touches the
-- new `factor_*` rows + `factors` category — the binary catalog is left
-- alone.

-- ─── Discriminator + scale columns on the catalog tag ────────────────
ALTER TABLE "mood_tags" ADD COLUMN "kind"      TEXT    NOT NULL DEFAULT 'BINARY';
ALTER TABLE "mood_tags" ADD COLUMN "scale_min" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "mood_tags" ADD COLUMN "scale_max" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "mood_tags" ADD COLUMN "inverse"   BOOLEAN NOT NULL DEFAULT false;

-- ─── Per-entry rating on the join ────────────────────────────────────
ALTER TABLE "mood_entry_tag_links" ADD COLUMN "rating" INTEGER;

-- ─── New category: factors ───────────────────────────────────────────
INSERT INTO "mood_tag_categories" ("id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mtc_factors', 'factors', 'mood.tagCategory.factors', 'SlidersHorizontal', 6, true)
ON CONFLICT ("key") DO UPDATE SET
  "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

-- ─── The five MVP rated factors ──────────────────────────────────────
-- work (1..5)
INSERT INTO "mood_tags"
  ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active", "kind", "scale_min", "scale_max", "inverse")
VALUES ('mt_factor_work', 'mtc_factors', 'factor_work', 'mood.tag.factorWork', 'Briefcase', 0, true, 'RATED', 1, 5, false)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order", "kind" = EXCLUDED."kind", "scale_min" = EXCLUDED."scale_min",
  "scale_max" = EXCLUDED."scale_max", "inverse" = EXCLUDED."inverse";

-- social (1..5)
INSERT INTO "mood_tags"
  ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active", "kind", "scale_min", "scale_max", "inverse")
VALUES ('mt_factor_social', 'mtc_factors', 'factor_social', 'mood.tag.factorSocial', 'Users', 1, true, 'RATED', 1, 5, false)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order", "kind" = EXCLUDED."kind", "scale_min" = EXCLUDED."scale_min",
  "scale_max" = EXCLUDED."scale_max", "inverse" = EXCLUDED."inverse";

-- sleep quality (1..5)
INSERT INTO "mood_tags"
  ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active", "kind", "scale_min", "scale_max", "inverse")
VALUES ('mt_factor_sleep_quality', 'mtc_factors', 'factor_sleep_quality', 'mood.tag.factorSleepQuality', 'Moon', 2, true, 'RATED', 1, 5, false)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order", "kind" = EXCLUDED."kind", "scale_min" = EXCLUDED."scale_min",
  "scale_max" = EXCLUDED."scale_max", "inverse" = EXCLUDED."inverse";

-- stress (1..5, inverse — higher = worse)
INSERT INTO "mood_tags"
  ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active", "kind", "scale_min", "scale_max", "inverse")
VALUES ('mt_factor_stress', 'mtc_factors', 'factor_stress', 'mood.tag.factorStress', 'Zap', 3, true, 'RATED', 1, 5, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order", "kind" = EXCLUDED."kind", "scale_min" = EXCLUDED."scale_min",
  "scale_max" = EXCLUDED."scale_max", "inverse" = EXCLUDED."inverse";

-- conflict (1..2 Yes/No, inverse — 1 = no conflict, 2 = conflict)
INSERT INTO "mood_tags"
  ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active", "kind", "scale_min", "scale_max", "inverse")
VALUES ('mt_factor_conflict', 'mtc_factors', 'factor_conflict', 'mood.tag.factorConflict', 'Swords', 4, true, 'RATED', 1, 2, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order", "kind" = EXCLUDED."kind", "scale_min" = EXCLUDED."scale_min",
  "scale_max" = EXCLUDED."scale_max", "inverse" = EXCLUDED."inverse";
