-- v1.22 (B2/B6) — Coach episodic reminder memory.
--
-- A time-anchored "bring this back later" intent the Coach captured from a
-- conversation. The missing memory type between coach_facts (durable traits)
-- and coach_plans (standing if-then habits): an episode with a due moment and
-- a done state. The free-text note is AES-256-GCM ciphertext stored as `bytea`
-- via the shared Bytes codec — the same shape as coach_plans.if_cue_encrypted.
-- metric / status / trigger fields / dates / source stay plain so the daily
-- sweep and the injection picker can rank and filter without a per-row decrypt.
-- status (proposed | active | due | surfaced | done | dismissed) and
-- trigger_kind (date | context) are app-side closed enums, deliberately NOT DB
-- enums so this migration stays purely additive. Soft-delete via deleted_at.
CREATE TABLE "coach_reminders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "note_encrypted" BYTEA NOT NULL,
    "metric" TEXT,
    "related_plan_id" TEXT,
    "trigger_kind" TEXT NOT NULL DEFAULT 'date',
    "due_at" TIMESTAMP(3),
    "context_cue" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL,
    "source_conversation_id" TEXT,
    "last_surfaced_at" TIMESTAMP(3),
    "surface_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "coach_reminders_pkey" PRIMARY KEY ("id")
);

-- The daily sweep scans a user's active reminders whose due_at has passed; the
-- status + deleted_at columns are part of that predicate, so the composite
-- index lets the planner serve the sweep + the injection read index-backed.
CREATE INDEX "coach_reminders_user_id_status_due_at_deleted_at_idx" ON "coach_reminders"("user_id", "status", "due_at", "deleted_at");

-- The context-cue evaluation pass filters by trigger_kind + status per user.
CREATE INDEX "coach_reminders_user_id_trigger_kind_status_idx" ON "coach_reminders"("user_id", "trigger_kind", "status");

ALTER TABLE "coach_reminders" ADD CONSTRAINT "coach_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
