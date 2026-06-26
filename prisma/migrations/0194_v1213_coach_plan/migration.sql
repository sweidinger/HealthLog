-- v1.21.3 (B1) — Coach goal / if-then implementation-plan memory.
--
-- Durable, user-scoped plans the Coach PROPOSES and the user CONFIRMS. The
-- extractor writes a row as status 'proposed'; only the user-facing PATCH
-- flips it to 'active'. Free-text fields (the if-cue, then-action, optional
-- target) are AES-256-GCM ciphertext stored as `bytea` via the shared Bytes
-- codec — the same shape as coach_facts.fact_encrypted. metric / status /
-- dates / source_conversation_id stay plain so the injection picker can rank
-- and filter without a per-row decrypt. status is an app-side closed enum
-- (proposed | active | met | abandoned), deliberately NOT a DB enum so this
-- migration stays purely additive. Soft-delete via deleted_at.
CREATE TABLE "coach_plans" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "if_cue_encrypted" BYTEA NOT NULL,
    "then_action_encrypted" BYTEA NOT NULL,
    "target_encrypted" BYTEA,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "review_date" TIMESTAMP(3),
    "source_conversation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "coach_plans_pkey" PRIMARY KEY ("id")
);

-- Injection picker scans a user's active plans newest-first; the status +
-- deleted_at columns are part of the predicate, so the composite index lets
-- the planner serve the read index-backed.
CREATE INDEX "coach_plans_user_id_status_deleted_at_idx" ON "coach_plans"("user_id", "status", "deleted_at");

ALTER TABLE "coach_plans" ADD CONSTRAINT "coach_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
