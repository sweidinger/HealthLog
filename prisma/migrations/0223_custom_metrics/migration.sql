-- v1.25.5 — user-defined custom metrics: catalog + values.
--
-- A self-hoster defines an arbitrary measurement (name, unit, optional target
-- window, decimals, description), logs values against it, and charts them. A
-- SEPARATE generic store from the closed `MeasurementType` enum + `measurements`
-- table: custom metrics are NOT synced, NOT in FHIR, NOT in AI insights — log +
-- chart only. `name` / `unit` / `description` stay plaintext (like the
-- biomarker catalog) so the list can sort + search.
--
-- `custom_metrics`        — the per-user catalog (soft-deleted via deleted_at).
-- `custom_metric_entries` — the logged values (hard-deleted; cascade from both
--                           the owning user and the parent metric).
--
-- Additive; no existing row touched. Idempotent guards (`IF NOT EXISTS` /
-- `DO $$`) so reruns are safe on prod. No backfill.
--
-- Reversibility (down):
--   DROP TABLE IF EXISTS "custom_metric_entries";
--   DROP TABLE IF EXISTS "custom_metrics";
-- A roll-back drops the feature wholesale — no other domain depends on it.

-- CreateTable: the per-user custom-metric catalog.
CREATE TABLE IF NOT EXISTS "custom_metrics" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "target_low" DOUBLE PRECISION,
    "target_high" DOUBLE PRECISION,
    "decimals" INTEGER,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "custom_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable: the logged values for each custom metric.
CREATE TABLE IF NOT EXISTS "custom_metric_entries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "custom_metric_id" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "measured_at" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_metric_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: owner scope on the catalog.
CREATE INDEX IF NOT EXISTS "custom_metrics_user_id_idx" ON "custom_metrics"("user_id");

-- CreateIndex: one catalog definition per (user, name).
CREATE UNIQUE INDEX IF NOT EXISTS "custom_metrics_user_id_name_key" ON "custom_metrics"("user_id", "name");

-- CreateIndex: the chart / list read path (owner + metric + time).
CREATE INDEX IF NOT EXISTS "custom_metric_entries_user_id_custom_metric_id_measured_at_idx" ON "custom_metric_entries"("user_id", "custom_metric_id", "measured_at");

-- AddForeignKey: catalog → user (cascade).
DO $$ BEGIN
  ALTER TABLE "custom_metrics" ADD CONSTRAINT "custom_metrics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey: entry → user (cascade).
DO $$ BEGIN
  ALTER TABLE "custom_metric_entries" ADD CONSTRAINT "custom_metric_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey: entry → metric (cascade).
DO $$ BEGIN
  ALTER TABLE "custom_metric_entries" ADD CONSTRAINT "custom_metric_entries_custom_metric_id_fkey" FOREIGN KEY ("custom_metric_id") REFERENCES "custom_metrics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
