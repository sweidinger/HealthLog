-- v1.11.1 — source-aware measurement rollups.
--
-- `measurement_rollups` is a derived cache; the authoritative readings live in
-- `measurements`. Existing rollup rows are SOURCE-BLIND aggregates: they group
-- by (type, day) only, so two sources reporting the same standard vital for one
-- day (e.g. WHOOP + Apple Watch resting heart rate) were AVG-blended into one
-- row. Re-grain the table to (type, day, source) so the read path can collapse
-- overlapping sources to the ladder-canonical reading while cumulative metrics
-- (steps, energy) still sum per source.
--
-- The existing rows cannot be re-grained in place (their source is unknown —
-- they already blend N sources), so purge them. This is non-destructive of user
-- data: the boot-time rollup backfill (`rollup-full-backfill`) and the
-- read-time self-heal (`ensureUserRollupsFresh` + the /api/measurements
-- coverage fallback) re-mint per-source rows on next worker boot / first read.
-- Bounded, idempotent, multi-tenant-safe; no operator action required.
DELETE FROM "measurement_rollups";

-- Additive column. DEFAULT only to satisfy NOT NULL during the (now empty)
-- table rewrite, then dropped so every writer must supply an explicit source.
ALTER TABLE "measurement_rollups"
  ADD COLUMN "source" "measurement_source" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "measurement_rollups" ALTER COLUMN "source" DROP DEFAULT;

-- Re-grain the primary key to include source. The hot descending index
-- (user_id, type, granularity, bucket_start DESC) is unchanged: readers fetch
-- every source for a (user, type) range and collapse in application code, so
-- they never filter by source in SQL.
ALTER TABLE "measurement_rollups" DROP CONSTRAINT "measurement_rollups_pkey";
ALTER TABLE "measurement_rollups"
  ADD CONSTRAINT "measurement_rollups_pkey"
  PRIMARY KEY ("user_id", "type", "granularity", "bucket_start", "source");
