-- v1.28.46 perf (H4) — partial indexes for the boot-time converging-backfill
-- discovery scans. Each discovery now runs a DB-level `SELECT DISTINCT user_id`
-- over a growth table filtered by a "still-un-migrated" predicate; without an
-- index that is a full filtered-partition scan at worker boot (the boot-storm
-- class on a heavy tenant). Each index below is PARTIAL on exactly the
-- discovery predicate, so the scan is index-only and shrinks to nothing as the
-- one-time backfill converges (a migrated row drops out of the predicate).
--
-- Additive-only: every statement is `CREATE INDEX IF NOT EXISTS`, no table
-- rewrite, no data change. NON-CONCURRENT on purpose — Prisma Migrate wraps a
-- migration file in a transaction and `CREATE INDEX CONCURRENTLY` cannot run in
-- one; these build at boot (docker-entrypoint runs `migrate deploy` BEFORE the
-- app serves traffic), so the brief build lock lands in the pre-traffic window.
-- Partial predicates match the write-side note convention (partial indexes are
-- raw-SQL-only here; Prisma cannot express a partial predicate — see the 0087 /
-- 0108 / 0183 precedents documented in schema.prisma).

-- note-encryption-backfill: measurements (densest table) + mood_entries.
CREATE INDEX IF NOT EXISTS "measurements_note_backfill_idx"
  ON "measurements" ("user_id")
  WHERE "notes" IS NOT NULL AND "notes_encrypted" IS NULL;

CREATE INDEX IF NOT EXISTS "mood_entries_note_backfill_idx"
  ON "mood_entries" ("user_id")
  WHERE "note" IS NOT NULL AND "note_encrypted" IS NULL;

-- med-notes-encryption-backfill: side-effects, inventory items, dose-changes.
-- Dose-changes carry no user_id; the discovery joins to medications on
-- medication_id, so the partial index leads with that join key.
CREATE INDEX IF NOT EXISTS "medication_side_effects_note_backfill_idx"
  ON "medication_side_effects" ("user_id")
  WHERE "notes" IS NOT NULL AND "notes_encrypted" IS NULL;

CREATE INDEX IF NOT EXISTS "medication_inventory_items_note_backfill_idx"
  ON "medication_inventory_items" ("user_id")
  WHERE "notes" IS NOT NULL AND "notes_encrypted" IS NULL;

CREATE INDEX IF NOT EXISTS "medication_dose_changes_note_backfill_idx"
  ON "medication_dose_changes" ("medication_id")
  WHERE "note" IS NOT NULL AND "note_encrypted" IS NULL;

-- lab-biomarker-backfill: unlinked live lab results.
CREATE INDEX IF NOT EXISTS "lab_results_biomarker_backfill_idx"
  ON "lab_results" ("user_id")
  WHERE "deleted_at" IS NULL AND "biomarker_id" IS NULL;

-- document-thumbnail-backfill: live thumbnailable documents. The thumbnail
-- absence lives on the `document_thumbnails` side table (a cross-table
-- anti-join, not indexable here); this partial index bounds the document-side
-- scan on `(user_id, mime_type)` for live rows, and the anti-join rides
-- `document_thumbnails.document_id` (already UNIQUE via the 1:1 relation).
CREATE INDEX IF NOT EXISTS "inbound_documents_thumbnail_backfill_idx"
  ON "inbound_documents" ("user_id", "mime_type")
  WHERE "deleted_at" IS NULL;
