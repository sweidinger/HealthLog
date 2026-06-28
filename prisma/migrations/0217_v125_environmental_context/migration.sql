-- v1.25 (W-ENV) — environmental-context module (opt-in, server-side v1).
--
-- Adds the per-day weather/daylight observation store and the manual travel
-- overrides, plus the coarse home-location columns on `users`. The module is
-- opt-in (default OFF via the module registry); with it off no row is written
-- and no outbound weather fetch runs.
--
-- Location granularity is coarse (city level / rounded lat-lon) by design — the
-- weather model only needs ~10–25 km and HealthLog never stores a GPS track.
--
-- Additive; no existing row touched. Idempotent guards (`IF NOT EXISTS` /
-- `DO $$`) so reruns are safe on prod.
--
-- Reversibility (down):
--   DROP TABLE IF EXISTS "environment_travel_locations";
--   DROP TABLE IF EXISTS "environment_contexts";
--   DROP TYPE  IF EXISTS "environment_location_source";
--   ALTER TABLE "users"
--     DROP COLUMN IF EXISTS "home_lat",
--     DROP COLUMN IF EXISTS "home_lon",
--     DROP COLUMN IF EXISTS "home_label",
--     DROP COLUMN IF EXISTS "home_timezone";
-- A roll-back drops the environment store wholesale — no other domain depends
-- on it.

-- AlterTable: coarse home location on the user (all nullable).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "home_lat" DOUBLE PRECISION;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "home_lon" DOUBLE PRECISION;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "home_label" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "home_timezone" TEXT;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "environment_location_source" AS ENUM ('HOME', 'TRAVEL');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "environment_contexts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "location_label" TEXT NOT NULL,
    "source" "environment_location_source" NOT NULL,
    "temp_min" DOUBLE PRECISION,
    "temp_max" DOUBLE PRECISION,
    "temp_mean" DOUBLE PRECISION,
    "apparent_mean" DOUBLE PRECISION,
    "sunshine_sec" INTEGER,
    "daylight_sec" INTEGER,
    "precip_sum" DOUBLE PRECISION,
    "pressure_mean" DOUBLE PRECISION,
    "pressure_delta" DOUBLE PRECISION,
    "humidity_mean" DOUBLE PRECISION,
    "cloud_mean" DOUBLE PRECISION,
    "weather_code" INTEGER,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "environment_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "environment_contexts_user_id_date_key" ON "environment_contexts"("user_id", "date");
CREATE INDEX IF NOT EXISTS "environment_contexts_user_id_date_idx" ON "environment_contexts"("user_id", "date");

-- CreateTable
CREATE TABLE IF NOT EXISTS "environment_travel_locations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "start_date" TEXT NOT NULL,
    "end_date" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "environment_travel_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "environment_travel_locations_user_id_start_date_end_date_idx" ON "environment_travel_locations"("user_id", "start_date", "end_date");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "environment_contexts" ADD CONSTRAINT "environment_contexts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "environment_travel_locations" ADD CONSTRAINT "environment_travel_locations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
