-- v1.8.5 — structured mood-tag taxonomy.
--
-- Adds a global Category -> Tag catalog plus a per-entry join, modelled
-- on the standalone mood diary's structured taxonomy. Purely additive:
-- the legacy flat `mood_entries.tags` JSON column is untouched and keeps
-- working for every existing row, the GLP-1 quick-tag chips, and the
-- Telegram / MoodLog sync. The structured taxonomy is a second, richer
-- capture surface; the tag-frequency / lift breakdown folds the two
-- axes together.
--
-- `label_key` columns carry an i18n message key (resolved client-side
-- against all six locales) rather than a hard-coded label, so the seeded
-- catalog renders localised everywhere. The seed at the bottom uses
-- deterministic ids + ON CONFLICT upsert so re-running is idempotent.
--
-- Reversibility (down):
--   DROP TABLE IF EXISTS "mood_entry_tag_links";
--   DROP TABLE IF EXISTS "mood_tags";
--   DROP TABLE IF EXISTS "mood_tag_categories";

-- CreateTable
CREATE TABLE "mood_tag_categories" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label_key" TEXT NOT NULL,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "mood_tag_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mood_tags" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label_key" TEXT NOT NULL,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "mood_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mood_entry_tag_links" (
    "mood_entry_id" TEXT NOT NULL,
    "mood_tag_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mood_entry_tag_links_pkey" PRIMARY KEY ("mood_entry_id","mood_tag_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mood_tag_categories_key_key" ON "mood_tag_categories"("key");

-- CreateIndex
CREATE UNIQUE INDEX "mood_tags_key_key" ON "mood_tags"("key");

-- CreateIndex
CREATE INDEX "mood_tags_category_id_sort_order_idx" ON "mood_tags"("category_id", "sort_order");

-- CreateIndex
CREATE INDEX "mood_entry_tag_links_mood_tag_id_idx" ON "mood_entry_tag_links"("mood_tag_id");

-- AddForeignKey
ALTER TABLE "mood_tags" ADD CONSTRAINT "mood_tags_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "mood_tag_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mood_entry_tag_links" ADD CONSTRAINT "mood_entry_tag_links_mood_entry_id_fkey" FOREIGN KEY ("mood_entry_id") REFERENCES "mood_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mood_entry_tag_links" ADD CONSTRAINT "mood_entry_tag_links_mood_tag_id_fkey" FOREIGN KEY ("mood_tag_id") REFERENCES "mood_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the default taxonomy (idempotent upsert by `key`). Mirrors
-- `src/lib/mood/tag-taxonomy.ts` — keep the two in sync if either
-- changes.
INSERT INTO "mood_tag_categories" ("id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mtc_feelings', 'feelings', 'mood.tagCategory.feelings', 'Heart', 0, true)
ON CONFLICT ("key") DO UPDATE SET
  "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_happy', 'mtc_feelings', 'happy', 'mood.tag.happy', 'Smile', 0, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_excited', 'mtc_feelings', 'excited', 'mood.tag.excited', 'Zap', 1, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_grateful', 'mtc_feelings', 'grateful', 'mood.tag.grateful', 'HandHeart', 2, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_relaxed', 'mtc_feelings', 'relaxed', 'mood.tag.relaxed', 'CloudSun', 3, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_content', 'mtc_feelings', 'content', 'mood.tag.content', 'ThumbsUp', 4, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_tired', 'mtc_feelings', 'tired', 'mood.tag.tired', 'Moon', 5, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_unsure', 'mtc_feelings', 'unsure', 'mood.tag.unsure', 'HelpCircle', 6, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_bored', 'mtc_feelings', 'bored', 'mood.tag.bored', 'Meh', 7, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_tense', 'mtc_feelings', 'tense', 'mood.tag.tense', 'AlertTriangle', 8, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_angry', 'mtc_feelings', 'angry', 'mood.tag.angry', 'Flame', 9, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_stressed', 'mtc_feelings', 'stressed', 'mood.tag.stressed', 'Brain', 10, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_sad', 'mtc_feelings', 'sad', 'mood.tag.sad', 'Frown', 11, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tag_categories" ("id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mtc_sleep', 'sleep', 'mood.tagCategory.sleep', 'BedDouble', 1, true)
ON CONFLICT ("key") DO UPDATE SET
  "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_slept_well', 'mtc_sleep', 'slept_well', 'mood.tag.sleptWell', 'Moon', 0, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_slept_ok', 'mtc_sleep', 'slept_ok', 'mood.tag.sleptOk', 'CloudMoon', 1, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_slept_poorly', 'mtc_sleep', 'slept_poorly', 'mood.tag.sleptPoorly', 'MoonStar', 2, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_early_night', 'mtc_sleep', 'early_night', 'mood.tag.earlyNight', 'Clock', 3, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tag_categories" ("id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mtc_health', 'health', 'mood.tagCategory.health', 'HeartPulse', 2, true)
ON CONFLICT ("key") DO UPDATE SET
  "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_worked_out', 'mtc_health', 'worked_out', 'mood.tag.workedOut', 'Dumbbell', 0, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_ate_well', 'mtc_health', 'ate_well', 'mood.tag.ateWell', 'Apple', 1, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_hydrated', 'mtc_health', 'hydrated', 'mood.tag.hydrated', 'GlassWater', 2, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_walked', 'mtc_health', 'walked', 'mood.tag.walked', 'Footprints', 3, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_alcohol', 'mtc_health', 'alcohol', 'mood.tag.alcohol', 'Wine', 4, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tag_categories" ("id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mtc_social', 'social', 'mood.tagCategory.social', 'Users', 3, true)
ON CONFLICT ("key") DO UPDATE SET
  "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_family', 'mtc_social', 'family', 'mood.tag.family', 'Home', 0, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_friends', 'mtc_social', 'friends', 'mood.tag.friends', 'Users', 1, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_party', 'mtc_social', 'party', 'mood.tag.party', 'PartyPopper', 2, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_alone', 'mtc_social', 'alone', 'mood.tag.alone', 'User', 3, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tag_categories" ("id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mtc_work', 'work', 'mood.tagCategory.work', 'Briefcase', 4, true)
ON CONFLICT ("key") DO UPDATE SET
  "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_productive', 'mtc_work', 'productive', 'mood.tag.productive', 'CheckCircle', 0, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_overtime', 'mtc_work', 'overtime', 'mood.tag.overtime', 'Clock', 1, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_day_off', 'mtc_work', 'day_off', 'mood.tag.dayOff', 'LogOut', 2, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_travel', 'mtc_work', 'travel', 'mood.tag.travel', 'Plane', 3, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";

INSERT INTO "mood_tags" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active")
VALUES ('mt_sick_day', 'mtc_work', 'sick_day', 'mood.tag.sickDay', 'Thermometer', 4, true)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id", "label_key" = EXCLUDED."label_key", "icon" = EXCLUDED."icon", "sort_order" = EXCLUDED."sort_order";
