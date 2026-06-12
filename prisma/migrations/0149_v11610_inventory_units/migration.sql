-- v1.16.10 — multi-unit inventory consumption.
--
-- `units_per_dose` (medications): how many inventory UNITS one dose
-- consumes (2 × 2 mg tablets for a 4 mg dose). Default 1 keeps every
-- existing medication on the one-unit-per-dose behaviour.
--
-- `container_type` (medication_inventory_items): what kind of physical
-- container the item is (pen / ampoule / blister pack / inhaler /
-- bottle). Display-level only. Backfilled PEN for items whose
-- medication is an INJECTION (the pre-v1.16.10 surface was pen-only),
-- OTHER for everything else.
--
-- `inventory_consumption` (medication_intake_events): the per-event
-- consumption stamp `[{itemId, units}]` — the exactly-once gate for
-- the consume hook and the refund ledger for the restore hook. NULL =
-- never consumed (pending / skipped / pre-v1.16.10 rows).
--
-- The Prisma fields `dosesTotal` / `dosesRemaining` are renamed to
-- `unitsTotal` / `unitsRemaining` at the client level only; the DB
-- columns keep their names via @map — zero data migration.

CREATE TYPE "medication_container_type" AS ENUM ('PEN', 'AMPOULE', 'BLISTER', 'INHALER', 'BOTTLE', 'OTHER');

ALTER TABLE "medications" ADD COLUMN "units_per_dose" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "medication_inventory_items" ADD COLUMN "container_type" "medication_container_type" NOT NULL DEFAULT 'OTHER';

ALTER TABLE "medication_intake_events" ADD COLUMN "inventory_consumption" JSONB;

-- Backfill: every existing item was registered through the pen-framed
-- surface; items on injection medications are pens.
UPDATE "medication_inventory_items" i
SET "container_type" = 'PEN'
FROM "medications" m
WHERE i."medication_id" = m."id"
  AND m."delivery_form" = 'INJECTION';
