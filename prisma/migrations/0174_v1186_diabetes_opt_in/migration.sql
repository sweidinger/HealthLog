-- v1.18.6 — diabetes opt-in for clinician glucose targets.
--
-- One additive, defaulted column on `users` so a user can declare "I have
-- diabetes / clinician glucose targets". When `true`, the glucose target
-- resolver applies the tighter ADA glycemic GOAL bands (fasting 80–130,
-- postprandial < 180) instead of the general non-diabetic normal bands.
--
-- This is NEVER auto-inferred from a reading and is NEVER a diagnosis — it is
-- a user-declared preference that only selects which target band the user is
-- judged against. The default `false` backfills every existing row onto the
-- general bands (the current behaviour), so the migration is a no-op for
-- anyone who never opts in.

ALTER TABLE "users"
  ADD COLUMN "has_diabetes" BOOLEAN NOT NULL DEFAULT false;
