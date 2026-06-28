-- v1.25 — type-less `(user_id, measured_at)` supporting index on `measurements`.
--
-- The bulk feature read (`extractFeatures`, src/lib/insights/features.ts) and
-- the consolidation scans walk a user's measurements ordered by `measured_at`
-- with no `type` predicate. The existing composite indexes cover
-- `(user_id, type, measured_at)`, `(user_id, source, measured_at)`, and
-- `(user_id, updated_at, id)` — none serves a type-less `(user_id, measured_at)`
-- range scan as a prefix. Without this index Postgres filters by `user_id` then
-- sorts the user's entire measurement set in memory on each of those reads,
-- which on a multi-year HealthKit tenant is hundreds of thousands of rows.
--
-- The composite `(user_id, measured_at)` index lets those reads stream straight
-- off the index in time order, which the newest-first row caps then bound.
--
-- Additive + order-safe: a pure `CREATE INDEX IF NOT EXISTS`, no column add, no
-- backfill, no rewrite of `measurements`.
--
-- Lock note: this is a plain, non-`CONCURRENTLY` index build, so it runs inside
-- Prisma's migration transaction and holds an ACCESS EXCLUSIVE lock on
-- `measurements` for the build's duration. The index covers every row (no
-- partial predicate), so on the largest multi-year HealthKit tenants the build
-- is slow; run the deploy at a low-traffic window on such deployments. A
-- `CONCURRENTLY` build cannot run inside the migration transaction; a plain
-- build is acceptable at this table size in the maintenance window.
--
-- Reversibility: down migration is
--   DROP INDEX IF EXISTS "measurements_user_id_measured_at_idx";

CREATE INDEX IF NOT EXISTS "measurements_user_id_measured_at_idx"
  ON "measurements" ("user_id", "measured_at");
