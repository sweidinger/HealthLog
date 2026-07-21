-- Efficacy target: allow a user's CustomMetric as the pinned "Wirkung" target.
--
-- Additive and a mirror of the existing biomarker path: one nullable column on
-- `medication_efficacy_targets`, its index, and a SET NULL foreign key to
-- `custom_metrics` so deleting a metric leaves the row as an orphan the
-- resolver already treats as "no override". No enum change, no backfill;
-- existing metric / lab targets are untouched. Forward-only; dropping the
-- column loses only custom-metric overrides (metric / lab overrides survive).

ALTER TABLE "medication_efficacy_targets" ADD COLUMN "custom_metric_id" TEXT;

CREATE INDEX "medication_efficacy_targets_custom_metric_id_idx"
  ON "medication_efficacy_targets"("custom_metric_id");

ALTER TABLE "medication_efficacy_targets"
  ADD CONSTRAINT "medication_efficacy_targets_custom_metric_id_fkey"
  FOREIGN KEY ("custom_metric_id") REFERENCES "custom_metrics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
