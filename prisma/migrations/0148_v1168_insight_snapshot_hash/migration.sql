-- v1.16.8 — content-hash gate for insight regeneration.
--
-- `insights_snapshot_hash` stores the SHA-256 fingerprint of the
-- compacted feature snapshot the cached comprehensive insight was
-- generated from. Nightly, forced, and lazy regenerations compare the
-- fresh snapshot's hash against it and skip the provider call
-- (refreshing only `insights_cached_at`) when nothing the prompt sees
-- has changed.
--
-- `insights_warm_failed_at` records the last failed/timed-out forced
-- warm of the comprehensive insight, so the forced path can back off
-- for an hour instead of re-attempting a broken provider chain on
-- every page-open. Additive + non-destructive.
ALTER TABLE "users" ADD COLUMN "insights_snapshot_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "insights_warm_failed_at" TIMESTAMP(3);
