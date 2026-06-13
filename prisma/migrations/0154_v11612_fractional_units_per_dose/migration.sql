-- v1.16.12 (#316) — fractional dosing.
--
-- A dose can consume a FRACTION of a unit (½ / ⅓ / ¼ of a tablet for a
-- split pill), so the unit↔dose factor and the per-container stock must
-- hold non-integer values: 30 tablets dosed at ½ each reads 29.5 after
-- one dose. Widen the three integer unit columns to NUMERIC; every
-- existing integer value casts losslessly. Additive and reversible in
-- value terms (all current rows are whole numbers).

ALTER TABLE "medications"
  ALTER COLUMN "units_per_dose" TYPE numeric(10,4) USING "units_per_dose"::numeric(10,4);

ALTER TABLE "medication_inventory_items"
  ALTER COLUMN "doses_total" TYPE numeric(12,4) USING "doses_total"::numeric(12,4),
  ALTER COLUMN "doses_remaining" TYPE numeric(12,4) USING "doses_remaining"::numeric(12,4);
