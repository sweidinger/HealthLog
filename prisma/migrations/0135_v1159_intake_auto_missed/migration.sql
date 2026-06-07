-- v1.15.9 — terminal "auto-missed" state for forgotten medication doses.
--
-- The hourly auto-miss cron previously flipped a never-acted pending dose to
-- `skipped = true`. Because the compliance engine excludes skipped doses from
-- the denominator (a deliberate user pause), a forgotten dose then neither
-- counted as taken nor as missed — silently inflating adherence.
--
-- This column lets the engine tell the two apart: a user-initiated skip stays
-- `skipped = true` (excluded), while a forgotten dose past its miss cutoff is
-- marked `auto_missed = true` and counts as a MISS against the rate. Every
-- legacy row defaults to false.
ALTER TABLE "medication_intake_events"
  ADD COLUMN "auto_missed" BOOLEAN NOT NULL DEFAULT false;
