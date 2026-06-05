-- v1.13.0 — per-user custom mood tags + per-user catalogue hide.
--
-- Additive, non-destructive:
--   1. `mood_tags` gains `user_id` (NULL = global catalogue, set = a user's
--      custom tag carrying a `custom:<cuid>` key) and `label_encrypted`
--      (AES-256-GCM ciphertext of a custom tag's free-text label; NULL for
--      catalogue rows, which resolve `label_key` against the locale).
--   2. New `mood_tag_hidden` join: a per-user hide of a CATALOGUE tag.
--   3. Seed the global `custom` category every user's custom tags hang under.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, and the
-- category seed upserts by `key` (deterministic id `mtc_custom`).

-- ─── 1. mood_tags: owner + encrypted custom label ────────────────────
ALTER TABLE "mood_tags" ADD COLUMN IF NOT EXISTS "user_id" TEXT;
ALTER TABLE "mood_tags" ADD COLUMN IF NOT EXISTS "label_encrypted" TEXT;

DO $$ BEGIN
  ALTER TABLE "mood_tags"
    ADD CONSTRAINT "mood_tags_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "mood_tags_user_id_idx" ON "mood_tags"("user_id");

-- ─── 2. mood_tag_hidden: per-user catalogue hide ─────────────────────
CREATE TABLE IF NOT EXISTS "mood_tag_hidden" (
  "user_id"     TEXT NOT NULL,
  "mood_tag_id" TEXT NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mood_tag_hidden_pkey" PRIMARY KEY ("user_id", "mood_tag_id")
);
CREATE INDEX IF NOT EXISTS "mood_tag_hidden_mood_tag_id_idx" ON "mood_tag_hidden"("mood_tag_id");

DO $$ BEGIN
  ALTER TABLE "mood_tag_hidden"
    ADD CONSTRAINT "mood_tag_hidden_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "mood_tag_hidden"
    ADD CONSTRAINT "mood_tag_hidden_mood_tag_id_fkey"
    FOREIGN KEY ("mood_tag_id") REFERENCES "mood_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 3. Seed the global `custom` category ────────────────────────────
INSERT INTO "mood_tag_categories"
  ("id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mtc_custom', 'custom', 'mood.tagCategory.custom', 'Tag', 100, true)
ON CONFLICT ("key") DO UPDATE SET
  "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order", "is_active" = EXCLUDED."is_active";
