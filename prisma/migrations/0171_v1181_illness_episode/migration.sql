-- v1.18.1 — illness / condition journal.
--
-- A CONDITION journal (not a flu log): any illness/condition kept for
-- oneself, with a retrospective lens. Retrospective + correlated, NEVER a
-- predictor/diagnoser. Born-gated by the module system — the gate is
-- app-layer, so there is no enable flag in the schema.
--
-- Tables (the daily timeline mirrors the Cycle three-table shape):
--
--   * `illness_episodes` — one episode. `illness_type` widens beyond an
--     infection log (infection / allergy / injury / mental-health /
--     autoimmune / chronic / other). `illness_lifecycle`
--     (ACUTE / CHRONIC_ONGOING / RECURRING / FLARE) distinguishes a bout from
--     an ongoing chronic condition; CHRONIC_ONGOING carries no resolved_at
--     and is excluded from the recovery-gap math. `parent_condition_id` is a
--     self-FK (ON DELETE SET NULL) so a flare/recurrence threads under one
--     parent condition. `note_encrypted` is a Bytes column (the AES-256-GCM
--     `*Encrypted` convention). Soft-deleted.
--
--   * `illness_day_logs` — one row per day of an episode (mirrors
--     cycle_day_logs): a coarse 0–3 `functional_impact` slider, an optional
--     `fever_c` reading (queryable plaintext, the basal_body_temp_c
--     precedent), an encrypted day note, the day's symptom links. Unique per
--     (episode_id, date). Soft-deleted.
--
--   * `illness_symptoms` — a seeded, icon-bearing, labelKey-i18n catalog
--     (Jackson / WURSS-derived; the cycle_symptoms precedent). Eight
--     high-signal cold/illness symptoms, scored 0–3 on the link.
--
--   * `illness_symptom_links` — the per-day-log join, composite PK
--     (day_log_id, symptom_id), 0–3 severity, cascade on both sides.
--
-- Additive; no existing row touched. The catalog seed uses deterministic
-- ids + ON CONFLICT ("key") DO NOTHING so re-running is a no-op (the
-- cycle/mood-tag seed precedent). Keep in sync with the app-side taxonomy
-- module if either changes.
--
-- Idempotent guards (`IF NOT EXISTS` / `DO $$`) so reruns are safe on prod.
--
-- Reversibility (down):
--   DROP TABLE IF EXISTS "illness_symptom_links";
--   DROP TABLE IF EXISTS "illness_symptoms";
--   DROP TABLE IF EXISTS "illness_day_logs";
--   DROP TABLE IF EXISTS "illness_episodes";
--   DROP TYPE  IF EXISTS "illness_lifecycle";
--   DROP TYPE  IF EXISTS "illness_type";
-- A roll-back drops the journal wholesale — no other domain depends on it.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "illness_type" AS ENUM ('INFECTION', 'ALLERGY', 'INJURY', 'MENTAL_HEALTH', 'AUTOIMMUNE', 'CHRONIC', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "illness_lifecycle" AS ENUM ('ACUTE', 'CHRONIC_ONGOING', 'RECURRING', 'FLARE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "illness_episodes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "illness_type" NOT NULL,
    "lifecycle" "illness_lifecycle" NOT NULL DEFAULT 'ACUTE',
    "onset_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "parent_condition_id" TEXT,
    "note_encrypted" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "illness_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "illness_day_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "episode_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "functional_impact" INTEGER,
    "fever_c" DOUBLE PRECISION,
    "note_encrypted" BYTEA,
    "tz" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "illness_day_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "illness_symptoms" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label_key" TEXT NOT NULL,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "illness_symptoms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "illness_symptom_links" (
    "day_log_id" TEXT NOT NULL,
    "symptom_id" TEXT NOT NULL,
    "severity" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "illness_symptom_links_pkey" PRIMARY KEY ("day_log_id","symptom_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "illness_episodes_user_id_deleted_at_idx" ON "illness_episodes"("user_id", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "illness_episodes_user_id_onset_at_idx" ON "illness_episodes"("user_id", "onset_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "illness_episodes_parent_condition_id_idx" ON "illness_episodes"("parent_condition_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "illness_day_logs_episode_id_date_key" ON "illness_day_logs"("episode_id", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "illness_day_logs_user_id_date_idx" ON "illness_day_logs"("user_id", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "illness_day_logs_episode_id_idx" ON "illness_day_logs"("episode_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "illness_symptoms_key_key" ON "illness_symptoms"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "illness_symptoms_sort_order_idx" ON "illness_symptoms"("sort_order");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "illness_symptom_links_symptom_id_idx" ON "illness_symptom_links"("symptom_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "illness_episodes" ADD CONSTRAINT "illness_episodes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "illness_episodes" ADD CONSTRAINT "illness_episodes_parent_condition_id_fkey" FOREIGN KEY ("parent_condition_id") REFERENCES "illness_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "illness_day_logs" ADD CONSTRAINT "illness_day_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "illness_day_logs" ADD CONSTRAINT "illness_day_logs_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "illness_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "illness_symptom_links" ADD CONSTRAINT "illness_symptom_links_day_log_id_fkey" FOREIGN KEY ("day_log_id") REFERENCES "illness_day_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "illness_symptom_links" ADD CONSTRAINT "illness_symptom_links_symptom_id_fkey" FOREIGN KEY ("symptom_id") REFERENCES "illness_symptoms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ─── Seed the default illness-symptom catalog ────────────────────────
-- Jackson/WURSS-derived high-signal cold/illness symptoms, scored 0–3 on
-- the link. Idempotent: deterministic ids + ON CONFLICT ("key") DO NOTHING
-- (the cycle_symptoms seed precedent 0129). Keep in sync with the app-side
-- illness symptom taxonomy if either changes.
INSERT INTO "illness_symptoms" ("id", "key", "label_key", "icon", "sort_order", "is_active") VALUES
  ('is_runny_nose',    'runny_nose',    'illness.symptom.runnyNose',    'Droplets',    0, true),
  ('is_stuffy_nose',   'stuffy_nose',   'illness.symptom.stuffyNose',   'Wind',        1, true),
  ('is_sneezing',      'sneezing',      'illness.symptom.sneezing',     'Waves',       2, true),
  ('is_sore_throat',   'sore_throat',   'illness.symptom.soreThroat',   'Flame',       3, true),
  ('is_cough',         'cough',         'illness.symptom.cough',        'Megaphone',   4, true),
  ('is_headache',      'headache',      'illness.symptom.headache',     'Brain',       5, true),
  ('is_body_aches',    'body_aches',    'illness.symptom.bodyAches',    'PersonStanding', 6, true),
  ('is_fatigue',       'fatigue',       'illness.symptom.fatigue',      'BatteryLow',  7, true)
ON CONFLICT ("key") DO NOTHING;
