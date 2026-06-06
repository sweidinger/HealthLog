-- v1.15.1 — seed the global `custom` cycle-symptom category.
--
-- Per-user custom symptoms (the v1.13 custom-mood-tag precedent) hang under a
-- single global category row, distinguished from the seeded catalogue by a
-- non-null `cycle_symptoms.user_id`. The owner column + `label_encrypted`
-- already exist (migration 0129); this only adds the parent category so a
-- custom symptom has a stable `category_id` to reference.
--
-- Idempotent: upserts by `key` (deterministic id `csc_custom`), so re-running
-- the migration is a no-op. No table or column changes.
INSERT INTO "cycle_symptom_categories"
  ("id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('csc_custom', 'custom', 'cycle.symptomCategory.custom', 'Tag', 100, true)
ON CONFLICT ("key") DO UPDATE SET
  "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order", "is_active" = EXCLUDED."is_active";
