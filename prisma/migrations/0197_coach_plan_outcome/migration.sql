-- v1.22 (W9, C2) — n-of-1 experiment outcome read-back, encrypted at rest.
-- An "experiment" is a CoachPlan with a reviewDate; when its review is
-- processed, the grounded before/after result is written here. Additive,
-- nullable Bytes column — no backfill, no enum change (the new statuses
-- review_due / reviewed are app-side strings on the existing `status` column).
ALTER TABLE "coach_plans" ADD COLUMN IF NOT EXISTS "outcome_encrypted" BYTEA;
