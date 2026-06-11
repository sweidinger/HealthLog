-- v1.16.5 — schedule-revision provenance.
--
-- The Zeitplan tab now lets a user append a PRE-tracking era by hand
-- ("the medication dosed at 07:00/19:00 from March to June, before I
-- edited it here"). Those rows are user-entered, not write-path
-- archives, so they must stay deletable without touching the archive
-- the schedule-replace path mints.
--
-- `source` records the provenance:
--   'ARCHIVED' — minted by the wholesale-replace write path (immutable
--                history; never deletable through the API).
--   'MANUAL'   — entered through POST
--                /api/medications/{id}/schedule-revisions (deletable by
--                the owner).
--
-- Additive + non-destructive: every existing row is a write-path
-- archive, so the default backfills correctly.
ALTER TABLE "medication_schedule_revisions"
    ADD COLUMN "source" TEXT NOT NULL DEFAULT 'ARCHIVED';
