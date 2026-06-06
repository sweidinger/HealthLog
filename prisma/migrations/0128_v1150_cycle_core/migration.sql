-- v1.15.0 — cycle tracking core.
--
-- Adds the eight cycle enums plus the three capture tables: the 1:1
-- CycleProfile settings row, the soft-deleted MenstrualCycle + CycleDayLog
-- capture rows (same syncVersion + deletedAt shape as MoodEntry so they
-- ride the `/api/sync/changes` delta feed), and their indexes / uniques.
-- Purely additive — no existing table is touched.
--
-- CycleDayLog carries the MoodEntry dual-unique: the canonical-day key
-- `(user_id, date)` plus the NULL-distinct external-dedup key
-- `(user_id, source, external_id)` for HealthKit re-ingest.
--
-- Reversibility (down):
--   DROP TABLE IF EXISTS "cycle_day_logs";
--   DROP TABLE IF EXISTS "menstrual_cycles";
--   DROP TABLE IF EXISTS "cycle_profiles";
--   DROP TYPE IF EXISTS "prediction_method";
--   DROP TYPE IF EXISTS "cycle_phase";
--   DROP TYPE IF EXISTS "contraceptive_kind";
--   DROP TYPE IF EXISTS "home_test_result";
--   DROP TYPE IF EXISTS "cervical_mucus";
--   DROP TYPE IF EXISTS "ovulation_test";
--   DROP TYPE IF EXISTS "flow_level";
--   DROP TYPE IF EXISTS "cycle_tracking_goal";

-- CreateEnum
CREATE TYPE "cycle_tracking_goal" AS ENUM ('GENERAL_HEALTH', 'AVOID_PREGNANCY', 'TRYING_TO_CONCEIVE', 'PERIMENOPAUSE', 'OFF');

-- CreateEnum
CREATE TYPE "flow_level" AS ENUM ('NONE', 'SPOTTING', 'LIGHT', 'MEDIUM', 'HEAVY');

-- CreateEnum
CREATE TYPE "ovulation_test" AS ENUM ('NEGATIVE', 'POSITIVE_LH_SURGE', 'ESTROGEN_SURGE', 'INDETERMINATE');

-- CreateEnum
CREATE TYPE "cervical_mucus" AS ENUM ('DRY', 'STICKY', 'CREAMY', 'WATERY', 'EGG_WHITE');

-- CreateEnum
CREATE TYPE "home_test_result" AS ENUM ('NEGATIVE', 'POSITIVE', 'INDETERMINATE');

-- CreateEnum
CREATE TYPE "contraceptive_kind" AS ENUM ('NONE', 'UNSPECIFIED', 'IMPLANT', 'INJECTION', 'IUD', 'INTRAVAGINAL_RING', 'ORAL', 'PATCH', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "cycle_phase" AS ENUM ('MENSTRUAL', 'FOLLICULAR', 'OVULATORY', 'LUTEAL');

-- CreateEnum
CREATE TYPE "prediction_method" AS ENUM ('CALENDAR', 'SYMPTOTHERMAL', 'TEMPERATURE_TREND', 'BLENDED');

-- CreateTable
CREATE TABLE "cycle_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "goal" "cycle_tracking_goal" NOT NULL DEFAULT 'GENERAL_HEALTH',
    "typical_cycle_length" INTEGER,
    "typical_period_length" INTEGER,
    "luteal_phase_length" INTEGER,
    "prediction_enabled" BOOLEAN NOT NULL DEFAULT true,
    "raw_chart_mode" BOOLEAN NOT NULL DEFAULT false,
    "discreet_notifications" BOOLEAN NOT NULL DEFAULT false,
    "sensitive_category_encryption" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cycle_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menstrual_cycles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "start_date" TEXT NOT NULL,
    "end_date" TEXT,
    "period_end_date" TEXT,
    "length_days" INTEGER,
    "ovulation_date" TEXT,
    "ovulation_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "is_predicted" BOOLEAN NOT NULL DEFAULT false,
    "tz" TEXT,
    "sync_version" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menstrual_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycle_day_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "cycle_id" TEXT,
    "flow" "flow_level",
    "intermenstrual_bleeding" BOOLEAN NOT NULL DEFAULT false,
    "basal_body_temp_c" DOUBLE PRECISION,
    "ovulation_test" "ovulation_test",
    "cervical_mucus" "cervical_mucus",
    "sexual_activity" BOOLEAN NOT NULL DEFAULT false,
    "protected_sex" BOOLEAN,
    "pregnancy_test" "home_test_result",
    "progesterone_test" "home_test_result",
    "contraceptive" "contraceptive_kind",
    "notes_encrypted" TEXT,
    "source" "measurement_source" NOT NULL DEFAULT 'MANUAL',
    "external_id" TEXT,
    "tz" TEXT,
    "sync_version" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cycle_day_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cycle_profiles_user_id_key" ON "cycle_profiles"("user_id");

-- CreateIndex
CREATE INDEX "menstrual_cycles_user_id_start_date_idx" ON "menstrual_cycles"("user_id", "start_date");

-- CreateIndex
CREATE INDEX "menstrual_cycles_user_id_updated_at_id_idx" ON "menstrual_cycles"("user_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "menstrual_cycles_user_id_start_date_key" ON "menstrual_cycles"("user_id", "start_date");

-- CreateIndex
CREATE INDEX "cycle_day_logs_user_id_date_idx" ON "cycle_day_logs"("user_id", "date");

-- CreateIndex
CREATE INDEX "cycle_day_logs_user_id_updated_at_id_idx" ON "cycle_day_logs"("user_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cycle_day_logs_user_id_date_key" ON "cycle_day_logs"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "cycle_day_logs_user_id_source_external_id_key" ON "cycle_day_logs"("user_id", "source", "external_id");

-- AddForeignKey
ALTER TABLE "cycle_profiles" ADD CONSTRAINT "cycle_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menstrual_cycles" ADD CONSTRAINT "menstrual_cycles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_day_logs" ADD CONSTRAINT "cycle_day_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_day_logs" ADD CONSTRAINT "cycle_day_logs_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "menstrual_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
