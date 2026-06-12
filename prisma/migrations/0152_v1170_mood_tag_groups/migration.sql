-- v1.17.0 — per-user custom mood-tag groups + per-user tag layout.
--
-- Additive, non-destructive (mirrors 0127_v1130_custom_mood_tags):
--   1. `mood_tag_categories` gains `user_id` (NULL = global seeded category,
--      set = a user's custom group carrying a `customcat:<uuid>` key) and
--      `label_encrypted` (AES-256-GCM ciphertext of a custom group's
--      free-text label; NULL for seeded rows, which resolve `label_key`
--      against the locale).
--   2. `users` gains `mood_tag_layout_json` — the per-user presentation blob
--      (group order + per-group tag placement), display-only, following the
--      `medication_list_layout_json` per-surface-column convention.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, constraint adds guarded by
-- duplicate_object, CREATE INDEX IF NOT EXISTS.

-- ─── 1. mood_tag_categories: owner + encrypted custom label ──────────
ALTER TABLE "mood_tag_categories" ADD COLUMN IF NOT EXISTS "user_id" TEXT;
ALTER TABLE "mood_tag_categories" ADD COLUMN IF NOT EXISTS "label_encrypted" TEXT;

DO $$ BEGIN
  ALTER TABLE "mood_tag_categories"
    ADD CONSTRAINT "mood_tag_categories_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "mood_tag_categories_user_id_idx" ON "mood_tag_categories"("user_id");

-- ─── 2. users: per-user mood-tag presentation blob ───────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mood_tag_layout_json" JSONB;
