-- v1.15.0 — cycle symptom taxonomy.
--
-- Clones the mood-tag trio (0101): a global Category -> Symptom catalog
-- plus a per-day-log join. `CycleSymptom` additionally carries
-- `user_id` + `label_encrypted` so a future release can mint per-user
-- custom symptoms; v1.15.0 ships seeded-catalogue-only.
--
-- `label_key` columns carry an i18n message key (resolved client-side
-- against all six locales) rather than a hard-coded label, so the seeded
-- catalog renders localised everywhere. The seed at the bottom uses
-- deterministic ids + ON CONFLICT DO NOTHING on `key` so re-running is a
-- no-op (idempotent).
--
-- Reversibility (down):
--   DROP TABLE IF EXISTS "cycle_symptom_links";
--   DROP TABLE IF EXISTS "cycle_symptoms";
--   DROP TABLE IF EXISTS "cycle_symptom_categories";

-- CreateTable
CREATE TABLE "cycle_symptom_categories" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label_key" TEXT NOT NULL,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "cycle_symptom_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycle_symptoms" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label_key" TEXT NOT NULL,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "user_id" TEXT,
    "label_encrypted" TEXT,

    CONSTRAINT "cycle_symptoms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycle_symptom_links" (
    "day_log_id" TEXT NOT NULL,
    "symptom_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cycle_symptom_links_pkey" PRIMARY KEY ("day_log_id","symptom_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cycle_symptom_categories_key_key" ON "cycle_symptom_categories"("key");

-- CreateIndex
CREATE UNIQUE INDEX "cycle_symptoms_key_key" ON "cycle_symptoms"("key");

-- CreateIndex
CREATE INDEX "cycle_symptoms_category_id_sort_order_idx" ON "cycle_symptoms"("category_id", "sort_order");

-- CreateIndex
CREATE INDEX "cycle_symptoms_user_id_idx" ON "cycle_symptoms"("user_id");

-- CreateIndex
CREATE INDEX "cycle_symptom_links_symptom_id_idx" ON "cycle_symptom_links"("symptom_id");

-- AddForeignKey
ALTER TABLE "cycle_symptoms" ADD CONSTRAINT "cycle_symptoms_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "cycle_symptom_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_symptoms" ADD CONSTRAINT "cycle_symptoms_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_symptom_links" ADD CONSTRAINT "cycle_symptom_links_day_log_id_fkey" FOREIGN KEY ("day_log_id") REFERENCES "cycle_day_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_symptom_links" ADD CONSTRAINT "cycle_symptom_links_symptom_id_fkey" FOREIGN KEY ("symptom_id") REFERENCES "cycle_symptoms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Seed the default symptom taxonomy ───────────────────────────────
-- Idempotent: deterministic ids + ON CONFLICT ("key") DO NOTHING (the
-- mood-tag seed precedent 0101 / 0118 / 0126). Three categories
-- (physical, emotional, digestive) with ~15 high-signal symptoms. Keep
-- in sync with `src/lib/cycle/symptom-taxonomy.ts` if either changes.

-- Categories
INSERT INTO "cycle_symptom_categories" ("id", "key", "label_key", "icon", "sort_order", "is_active") VALUES
  ('csc_physical',  'physical',  'cycle.symptomCategory.physical',  'Activity', 0, true),
  ('csc_emotional', 'emotional', 'cycle.symptomCategory.emotional', 'Heart',    1, true),
  ('csc_digestive', 'digestive', 'cycle.symptomCategory.digestive', 'Soup',     2, true)
ON CONFLICT ("key") DO NOTHING;

-- Symptoms
INSERT INTO "cycle_symptoms" ("id", "category_id", "key", "label_key", "icon", "sort_order", "is_active") VALUES
  ('cs_cramps',            'csc_physical',  'cramps',            'cycle.symptom.cramps',            'Zap',          0, true),
  ('cs_headache',          'csc_physical',  'headache',          'cycle.symptom.headache',          'Brain',        1, true),
  ('cs_bloating',          'csc_physical',  'bloating',          'cycle.symptom.bloating',          'CircleDot',    2, true),
  ('cs_acne',              'csc_physical',  'acne',              'cycle.symptom.acne',              'Droplet',      3, true),
  ('cs_breast_tenderness', 'csc_physical',  'breast_tenderness', 'cycle.symptom.breastTenderness',  'HeartPulse',   4, true),
  ('cs_fatigue',           'csc_physical',  'fatigue',           'cycle.symptom.fatigue',           'BatteryLow',   5, true),
  ('cs_back_pain',         'csc_physical',  'back_pain',         'cycle.symptom.backPain',          'PersonStanding', 6, true),
  ('cs_insomnia',          'csc_physical',  'insomnia',          'cycle.symptom.insomnia',          'MoonStar',     7, true),
  ('cs_libido_high',       'csc_emotional', 'libido_high',       'cycle.symptom.libidoHigh',        'Flame',        0, true),
  ('cs_libido_low',        'csc_emotional', 'libido_low',        'cycle.symptom.libidoLow',         'Snowflake',    1, true),
  ('cs_mood_swings',       'csc_emotional', 'mood_swings',       'cycle.symptom.moodSwings',        'Drama',        2, true),
  ('cs_food_cravings',     'csc_digestive', 'food_cravings',     'cycle.symptom.foodCravings',      'Cookie',       0, true),
  ('cs_nausea',            'csc_digestive', 'nausea',            'cycle.symptom.nausea',            'Frown',        1, true),
  ('cs_diarrhea',          'csc_digestive', 'diarrhea',          'cycle.symptom.diarrhea',          'Toilet',       2, true),
  ('cs_constipation',      'csc_digestive', 'constipation',      'cycle.symptom.constipation',      'CircleSlash',  3, true)
ON CONFLICT ("key") DO NOTHING;
