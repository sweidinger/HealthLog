-- v1.15.0 — cycle-tracking feature enable flag.
--
-- Adds the per-user `cycle_tracking_enabled` toggle to `cycle_profiles`.
-- The column is NULLABLE on purpose: NULL means "derive from gender"
-- (`FEMALE` → enabled, everything else → disabled), so no row backfill
-- is required — existing profiles read NULL and resolve through the
-- `isCycleEnabled()` gate helper. An explicit `true` opts a non-FEMALE
-- account in (Settings toggle); an explicit `false` opts a FEMALE
-- account out. Every `/api/cycle/*` route returns
-- `403 { error, meta:{ errorCode:"cycle.disabled" } }` when the resolved
-- value is false.
--
-- Reversibility (down):
--   ALTER TABLE "cycle_profiles" DROP COLUMN IF EXISTS "cycle_tracking_enabled";

-- AlterTable
ALTER TABLE "cycle_profiles" ADD COLUMN "cycle_tracking_enabled" BOOLEAN;
