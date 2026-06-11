-- v1.16.6 — audit trail for corrected schedule archives.
--
-- The Zeitplan tab now lets the owner CORRECT a recorded era. A MANUAL
-- era is edited in place; an ARCHIVED era (minted by the write path)
-- stays immutable — the correction is written as a new MANUAL row and
-- this column on the original points at it. Every era consumer (the
-- splitter, the list endpoint, live-boundary reads) skips superseded
-- rows, so the correction takes the original's place while the
-- original remains as the audit record.
--
-- Additive + non-destructive: NULL means "active era", which is what
-- every existing row is.
ALTER TABLE "medication_schedule_revisions"
    ADD COLUMN "superseded_by_revision_id" TEXT;
