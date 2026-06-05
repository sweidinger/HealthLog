-- v1.12.1 — partial unique index scoped to live rows
-- (`WHERE deleted_at IS NULL`) on MedicationIntakeEvent.
--
-- Problem. `MedicationIntakeEvent` carries a `deleted_at` tombstone, but
-- its unique constraint (0073) covers every row regardless of tombstone
-- state. A soft-deleted slot row therefore keeps occupying its unique
-- slot, which breaks delete-then-retake: `applyCanonicalSlotWrite`
-- (`src/lib/medications/scheduling/slot-upsert.ts`) finds no LIVE row for
-- a slot the user previously deleted, tries to CREATE, and P2002s against
-- the tombstone on `(user_id, medication_id, scheduled_for, source)`; the
-- catch re-finds only live rows, finds none, and re-throws — the re-take
-- 500s. The slot-dedup job already has to catch-and-skip this exact
-- collision (`intake-slot-dedup.ts:257-298`).
--
-- Fix. Replace the full unique CONSTRAINT with a PARTIAL unique INDEX
-- predicated on `deleted_at IS NULL`. Live-row uniqueness still holds;
-- tombstones drop out of the index entirely, so a re-take re-creates the
-- slot row cleanly instead of P2002-ing against the tombstone. Prisma
-- can't express a partial-predicate unique, so this is hand-written (same
-- reason as the step-consolidation / dense-intraday partial indexes in
-- 0087 / 0108). The schema keeps the full `@@unique` (which generates the
-- `userId_medicationId_scheduledFor_source` compound where-key the slot
-- finder uses) with a comment pointing here.
--
-- Why intake and NOT Measurement / Workout here:
--   * Measurement — its compound-key write path uses `prisma.upsert`
--     (consolidate-daily-mean, drain-per-sample-cumulative, the Fitbit /
--     WHOOP / Apple-Health sync, Apple-export import). Prisma 7 compiles
--     a compound-key `upsert` to native `INSERT ... ON CONFLICT (cols)`,
--     and Postgres rejects an `ON CONFLICT` arbiter that targets a
--     PARTIAL unique without the matching predicate (which Prisma does
--     not emit). Several of those upserts also intentionally RESURRECT a
--     tombstoned canonical row (`update: { deletedAt: null }` in
--     consolidate-daily-mean) — a behaviour that depends on the full
--     unique covering tombstoned rows. Converting Measurement to a
--     partial unique would break every one of those upserts. The
--     Measurement batch-ingest resurrection gap is instead closed at the
--     application layer (the existence probe filters `deletedAt: null`).
--   * Workout — has no `deleted_at` column (workout deletes are hard
--     deletes), so there is no tombstone to collide with.
-- MedicationIntakeEvent has NO `upsert` call site (every writer is
-- `create` / `createMany` + a P2002 catch, and `createMany skipDuplicates`
-- compiles to `ON CONFLICT DO NOTHING` without a target, which a partial
-- index satisfies), so the partial unique is safe here and nowhere else.
--
-- DEDUP-FIRST. A partial unique build fails if two LIVE rows already
-- share the tuple. Before the `CREATE UNIQUE INDEX` the migration
-- collapses any existing duplicate live rows, keeping the newest
-- (`updated_at` then `id` as the tie-break) and tombstoning the rest
-- (soft-delete, not hard-delete, so the audit/sync trail is preserved and
-- a paired client still reconciles the collapse). Idempotent: the dedup
-- is a no-op on a clean table and the index builds with `IF NOT EXISTS`.
--
-- Lock note (conscious trade-off): this is a plain, non-`CONCURRENTLY`
-- index build, so it runs inside Prisma's migration transaction and
-- briefly holds ACCESS EXCLUSIVE on the table. The duplicate-live-row
-- DELETE-then-CREATE pair is sub-second on every normal deployment.

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "user_id", "medication_id", "scheduled_for", "source"
      ORDER BY "updated_at" DESC, "id" DESC
    ) AS rn
  FROM "medication_intake_events"
  WHERE "deleted_at" IS NULL
)
UPDATE "medication_intake_events" e
SET "deleted_at" = NOW(), "sync_version" = e."sync_version" + 1
FROM ranked r
WHERE e."id" = r."id" AND r.rn > 1;

ALTER TABLE "medication_intake_events"
  DROP CONSTRAINT IF EXISTS "medication_intake_events_user_id_medication_id_scheduled_for_source_key";

CREATE UNIQUE INDEX IF NOT EXISTS "medication_intake_events_user_med_slot_source_live_key"
  ON "medication_intake_events" ("user_id", "medication_id", "scheduled_for", "source")
  WHERE "deleted_at" IS NULL;
