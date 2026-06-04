-- v1.12.0 — add a rated `factor_family` to the mood factor catalog.
--
-- Follow-up to 0119: the operator asked for a "family" rating, and `family`
-- existed only as a BINARY tag. This seeds a sixth RATED factor under the
-- existing `factors` category (`mtc_factors`), scale 1..5, not inverse
-- (higher = a better family day). Strictly additive — no schema change, the
-- catalog is read dynamically by `GET /api/mood/tags`, so iOS and web pick
-- it up with no client change. Deterministic id + ON CONFLICT upsert keep
-- the seed idempotent, mirroring 0119.

INSERT INTO "mood_tags"
  ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active", "kind", "scale_min", "scale_max", "inverse")
VALUES ('mt_factor_family', 'mtc_factors', 'factor_family', 'mood.tag.factorFamily', 'Home', 5, true, 'RATED', 1, 5, false)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order", "kind" = EXCLUDED."kind", "scale_min" = EXCLUDED."scale_min",
  "scale_max" = EXCLUDED."scale_max", "inverse" = EXCLUDED."inverse";
