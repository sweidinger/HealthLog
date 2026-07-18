-- v1.30.12 perf — index the two medication-intake read shapes the dashboard
-- "meds today" builder fires that could not index-seek before: the sibling
-- reads filtering (user_id, scheduled_for) without medication_id, and the
-- per-medication last-taken group-by that scanned the whole intake history.
-- Additive; no data change.

-- CreateIndex
CREATE INDEX "medication_intake_events_user_id_scheduled_for_idx" ON "medication_intake_events"("user_id", "scheduled_for");

-- CreateIndex
CREATE INDEX "medication_intake_events_user_id_medication_id_taken_at_idx" ON "medication_intake_events"("user_id", "medication_id", "taken_at");
