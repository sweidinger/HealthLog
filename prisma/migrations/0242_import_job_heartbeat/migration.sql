-- Import-job liveness heartbeat (issue #486 follow-up).
--
-- `reconcileOrphanImportJobs` used to flip EVERY non-terminal ImportJob
-- row to `failed` on any worker boot — killing an import that was still
-- actively parsing in another worker (multi-replica / rolling deploy).
-- The reconcile now gates on this heartbeat: a non-terminal row is only
-- treated as orphaned when its pg-boss job is gone/terminal OR its
-- heartbeat has gone stale. `@updatedAt` bumps this column on every
-- write, including each mid-run progress tick, so a live import keeps it
-- fresh. Existing rows backfill to the ALTER time via the DB default.
ALTER TABLE "import_jobs"
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
