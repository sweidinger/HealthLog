-- Preserve the original landing time for markers that predate `arrived_at`.
-- Migration 0260 must add the NOT NULL column with a default; this follow-up
-- restores historical rows to their actual first-arrival timestamp before the
-- application starts serving the release.
UPDATE "arrival_reactions"
SET "arrived_at" = "created_at";
