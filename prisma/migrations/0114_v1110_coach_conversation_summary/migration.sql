-- v1.11.0 — rolling encrypted conversation summary for the Coach.
-- Additive only; safe on a populated table (nullable + defaulted).
ALTER TABLE "coach_conversations" ADD COLUMN IF NOT EXISTS "summary_encrypted" BYTEA;
ALTER TABLE "coach_conversations" ADD COLUMN IF NOT EXISTS "summary_updated_at" TIMESTAMP(3);
ALTER TABLE "coach_conversations" ADD COLUMN IF NOT EXISTS "summary_turn_count" INTEGER NOT NULL DEFAULT 0;
