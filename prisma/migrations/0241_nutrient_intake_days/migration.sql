-- v1.28 — micronutrient intake daily totals (opt-in `nutrients` module).
--
-- One row per (user, local day, nutrient): vitamins, minerals, water and
-- caffeine as supplement-style day totals synced from Apple Health. The
-- composite PK is the idempotency key — an iOS re-post of a grown day
-- total replaces the row in place (last-writer-wins day-total contract),
-- so there is no externalId column and no soft delete. `day` is a
-- YYYY-MM-DD TEXT key anchored to the user's IANA timezone (the
-- EnvironmentContext / MedicationComplianceRollup day-key precedent);
-- `nutrient` is a bare TEXT code enforced in code against the closed
-- catalog (`src/lib/nutrients/catalog.ts`) so adding a code never needs
-- a migration. `unit` is denormalised from the catalog on purpose: rows
-- stay self-describing in exports even if the catalog ever drifts.
CREATE TABLE "nutrient_intake_days" (
  "user_id" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "nutrient" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "unit" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'APPLE_HEALTH',
  "external_source_version" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "nutrient_intake_days_pkey" PRIMARY KEY ("user_id", "day", "nutrient")
);

-- Read path: the settings-card / read-endpoint window scan per user, and
-- the later per-nutrient series fetch (day DESC for "latest first").
CREATE INDEX "nutrient_intake_days_user_id_nutrient_day_idx"
  ON "nutrient_intake_days" ("user_id", "nutrient", "day" DESC);

-- Account deletion cascades; rows are worthless without their owner.
ALTER TABLE "nutrient_intake_days"
  ADD CONSTRAINT "nutrient_intake_days_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
