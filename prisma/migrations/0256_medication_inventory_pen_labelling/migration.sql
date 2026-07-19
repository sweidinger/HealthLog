-- Carton labelling for an inventory container: manufacturer + printed strength.
--
-- The native client's pen list uses these two as its headline and subhead, so
-- a container created on the web could not be shown there without fabricating
-- an empty card. Nothing on the server held them, so the client kept its own
-- copy locally and no back-fill was possible.
--
-- Both are additive and nullable. Every pre-existing row is truthfully NULL:
-- the values were never collected, and a plain supply row (a blister pack, a
-- bottle) has no use for either. No backfill, no default, no rewrite of the
-- table's existing contents.
ALTER TABLE "medication_inventory_items"
  ADD COLUMN "manufacturer" TEXT,
  ADD COLUMN "dose_strength" TEXT;
