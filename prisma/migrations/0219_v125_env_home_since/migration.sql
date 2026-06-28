-- v1.25 (W-ENV) — conservative past-location handling for the environmental
-- context module.
--
-- Adds `users.home_since` (effective-from instant for the home location) and a
-- `DEVICE` value to the location-source enum. Day resolution attributes a past
-- day to the home location ONLY when the day is on/after `home_since`; earlier
-- days are skipped rather than fabricated from the current home. The deep past
-- is filled by explicit dated location periods instead.
--
-- `DEVICE` is the reserved forward path for a future client-supplied coarse
-- per-day location (iOS v2). The value exists so the resolver and the wire
-- contract already accept it; nothing writes it server-side yet.
--
-- Backfill of existing accounts: any row that already has a home location gets
-- `home_since` stamped to the migration instant. This is conservative — the
-- exact day a pre-upgrade account moved into its home is unknown, so history
-- before the upgrade is left to explicit location periods rather than guessed.
--
-- Additive; no existing weather row touched. Idempotent guards so reruns are
-- safe on prod.
--
-- Reversibility (down):
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "home_since";
--   -- (the `DEVICE` enum value cannot be dropped in place; it is inert until a
--   --  future client writes it, so a roll-back leaves it harmless.)

-- AlterTable: effective-from instant for the home location (nullable).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "home_since" TIMESTAMP(3);

-- Backfill: stamp existing home rows so they resolve from the upgrade forward.
UPDATE "users"
  SET "home_since" = CURRENT_TIMESTAMP
  WHERE "home_lat" IS NOT NULL AND "home_since" IS NULL;

-- AlterEnum: reserve the DEVICE source for the iOS v2 forward path.
ALTER TYPE "environment_location_source" ADD VALUE IF NOT EXISTS 'DEVICE';
