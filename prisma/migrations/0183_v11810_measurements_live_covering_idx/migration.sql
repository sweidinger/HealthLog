-- v1.18.10 P-5 — covering partial index for soft-delete-filtered reads.
--
-- The hot reads on `measurements` all filter `deleted_at IS NULL` and order
-- `measured_at DESC` per type — the DISTINCT-ON-latest pass, the management
-- list, the series reads, and the per-type count. The base
-- `(user_id, type, measured_at)` index is ASC and does NOT carry
-- `deleted_at`, so those reads pay a heap re-check of `deleted_at` over the
-- type partition for every candidate row.
--
-- Two partial indexes already cover the highest-volume types
-- (`measurements_dense_intraday_retention_idx` for HRV/PULSE, migration 0108;
-- `measurements_legacy_step_consolidation_idx` for ACTIVITY_STEPS, migration
-- 0087). This index closes the gap for every OTHER type: a covering partial
-- index keyed `(user_id, type, measured_at DESC)` over live rows only serves
-- the latest / list / series reads without the heap re-check, and — being
-- partial on `deleted_at IS NULL` — it carries no entries for tombstoned rows.
--
-- Additive + order-safe: a pure `CREATE INDEX IF NOT EXISTS`, no column add,
-- no backfill, no rewrite of `measurements`.
--
-- Prisma can't express a partial-predicate index, so it lives here in raw
-- migration SQL and is intentionally omitted from `schema.prisma` (the same
-- treatment migrations 0087 + 0108 use; a comment on the model documents it).
--
-- Idempotent guard (`IF NOT EXISTS`) makes reruns safe. Forward-only.
--
-- Lock note (conscious trade-off): a plain, non-`CONCURRENTLY` build, so it
-- runs inside Prisma's migration transaction and holds an ACCESS EXCLUSIVE
-- lock on `measurements` for the build. On the largest multi-year HealthKit
-- tenants the live row set is large, so deploy at a low-traffic window. A
-- `CONCURRENTLY` build cannot run inside the migration transaction and is not
-- used here to keep the migration atomic with the rest of the release.
--
-- Reversibility:
--   DROP INDEX IF EXISTS "measurements_live_covering_idx";
-- A roll-back loses only the scan acceleration; no data is touched.

CREATE INDEX IF NOT EXISTS "measurements_live_covering_idx"
  ON "measurements" ("user_id", "type", "measured_at" DESC)
  WHERE "deleted_at" IS NULL;
