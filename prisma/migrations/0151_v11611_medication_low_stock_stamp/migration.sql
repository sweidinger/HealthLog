-- v1.16.11 — low-stock notification stamp (medications).
--
-- The daily low-stock pass notifies once per threshold crossing:
-- `low_stock_notified_at` records the dispatch instant,
-- `low_stock_notified_threshold_days` the user threshold (days of
-- remaining runway) it was written against. The pass clears both when
-- the projected runway rises back to / above the threshold (refill),
-- and treats a differing stamped threshold as re-armed. NULL = armed.

ALTER TABLE "medications" ADD COLUMN "low_stock_notified_at" TIMESTAMP(3);
ALTER TABLE "medications" ADD COLUMN "low_stock_notified_threshold_days" INTEGER;
