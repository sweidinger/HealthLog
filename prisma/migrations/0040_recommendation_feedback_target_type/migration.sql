-- v1.4.23 H7 — polymorphic feedback target.
--
-- Reuses the v1.4.16 B5e RecommendationFeedback table for Coach
-- assistant-message thumbs so the aggregator only has to slice one
-- table. `target_type` defaults to "recommendation" so every
-- pre-v1.4.23 row reads as the existing surface; new Coach rows write
-- "coach" + the message id in the existing `recommendation_id` slot.
-- `reason` is optional free-form prose (capped to 200 chars by the
-- route).
--
-- Index on (target_type, created_at) lets the admin aggregator scan
-- per-surface buckets without a full table sweep.
ALTER TABLE "recommendation_feedback"
ADD COLUMN IF NOT EXISTS "target_type" TEXT NOT NULL DEFAULT 'recommendation',
ADD COLUMN IF NOT EXISTS "reason" TEXT;

CREATE INDEX IF NOT EXISTS "recommendation_feedback_target_type_created_at_idx"
ON "recommendation_feedback" ("target_type", "created_at");
