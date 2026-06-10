-- v1.16.0 — structured self-context fields on the health profile.
--
-- Three short structured companions to the free-text "about me"
-- (chronic conditions, allergies/intolerances, what the Coach should
-- watch), each encrypted at rest through the shared Bytes codec and
-- capped at 500 chars BEFORE encryption. Age/gender deliberately do
-- NOT live here — they come from the users table and are merged into
-- the prompt block at assembly time.
--
-- `pending_questions_encrypted` carries up to 3 clarifying questions
-- the server derives after a save (encrypted JSON string[]); the Coach
-- composer renders them as tappable suggestion chips. Additive +
-- non-destructive.
ALTER TABLE "user_health_profiles" ADD COLUMN "conditions_encrypted" BYTEA;
ALTER TABLE "user_health_profiles" ADD COLUMN "allergies_encrypted" BYTEA;
ALTER TABLE "user_health_profiles" ADD COLUMN "coach_focus_encrypted" BYTEA;
ALTER TABLE "user_health_profiles" ADD COLUMN "pending_questions_encrypted" BYTEA;
