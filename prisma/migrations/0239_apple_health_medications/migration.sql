-- v1.28 — Apple Health medications + intake (server contract, #423).
--
-- iOS 26+ HealthKit exposes the user's medication list
-- (`HKUserAnnotatedMedication`, stable `medicationConceptIdentifier`) and
-- dose events (`HKMedicationDoseEvent`, stable UUID, taken/skipped),
-- read-only. The server side is purely additive: a provenance pair on
-- `medications` (a med with `external_source` set is MIRRORED from that
-- source — source-exclusive, no cross-source slot collapse) and an
-- external dose-event id on `medication_intake_events` that makes the
-- bulk re-sync idempotent.

-- ── 1. intake_source — append the Apple Health source ──────────────────
--
-- Purely-additive enum extension; no row touched. `ADD VALUE IF NOT
-- EXISTS` makes the rerun safe. The new value is NOT used elsewhere in
-- this migration (the columns below are typed `intake_source` but no row
-- is inserted or updated), so it is safe to extend the enum in the same
-- step — Postgres only forbids USING a freshly-added enum value inside
-- the transaction that added it.
ALTER TYPE "intake_source" ADD VALUE IF NOT EXISTS 'APPLE_HEALTH';

-- ── 2. medications — mirrored-medication provenance ────────────────────
--
-- `external_source` non-NULL marks the row a read-only mirror of an
-- external medication list; `external_id` carries the source's stable
-- concept identifier (HealthKit `medicationConceptIdentifier`). Both
-- nullable, no default, no backfill: every existing row stays a native
-- HealthLog medication.
ALTER TABLE "medications"
  ADD COLUMN "external_source" "intake_source",
  ADD COLUMN "external_id" TEXT;

-- One mirror row per external concept per user. A plain (non-partial)
-- unique matching the schema's `@@unique([userId, externalSource,
-- externalId])`: Postgres treats NULLs as distinct in unique indexes, so
-- the existing rows (both columns NULL) are unaffected — only genuinely
-- mirrored medications occupy a slot. The create route pre-queries the
-- triple and returns the existing medication; this index is the race
-- backstop (concurrent create surfaces P2002, which the route resolves
-- to the winning row).
CREATE UNIQUE INDEX "medications_user_id_external_source_external_id_key"
  ON "medications" ("user_id", "external_source", "external_id");

-- ── 3. medication_intake_events — external dose-event id ───────────────
--
-- Carries the HealthKit `HKMedicationDoseEvent` UUID. Nullable, no
-- backfill: NULL for every non-mirrored row.
ALTER TABLE "medication_intake_events"
  ADD COLUMN "external_id" TEXT;

-- Idempotent re-import: one LIVE row per `(user_id, external_id)`. A
-- partial unique like the live-row slot unique from migration 0121 —
-- restricted to non-NULL externalIds (rows without one, i.e. everything
-- pre-Apple, stay unconstrained and out of the index) and to live rows
-- (`deleted_at IS NULL`, so a tombstone never blocks the sync ledger).
-- The bulk intake route pre-checks the batch's externalIds and reports
-- replays as duplicates; this index is the race backstop. Prisma can't
-- express a partial-predicate unique, so this is hand-written and the
-- schema keeps the full `@@unique` for the compound where-key.
CREATE UNIQUE INDEX "medication_intake_events_user_external_id_live_key"
  ON "medication_intake_events" ("user_id", "external_id")
  WHERE "external_id" IS NOT NULL AND "deleted_at" IS NULL;
