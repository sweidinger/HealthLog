-- v1.4.23 H4 — per-user Coach prompt-tuning preferences.
--
-- The Coach drawer's settings cog returned in v1.4.23 (the v1.4.22 B5
-- audit had pulled the dead placeholder cog out so it stayed empty
-- until the per-user surface was real). Persist the four controls the
-- cog exposes — tone, verbosity, excludeMetrics, showEvidenceByDefault
-- — as a single nullable Json column so adding new knobs in v1.5
-- (e.g., per-source language preference) doesn't churn the schema.
--
-- Default behaviour stays exactly v1.4.22 when the column is NULL —
-- tone="warm", verbosity="default", no metrics excluded, evidence
-- disclosure closed by default. The Coach prompt builder reads the
-- column and folds non-default knobs into the system prompt prefix.
ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "coach_prefs_json" JSONB;
