-- v1.18.6 (L1) — covering index for the Coach assistant-message scans.
--
-- Two hot reads walk a user's assistant messages newest-first:
--   * the global Coach FAB poll (`GET /api/insights/coach/nudge-status`) —
--     the newest assistant message across the caller's conversations, used
--     to decide whether the unread dot paints; and
--   * the proactive-nudge cron's frequency gate (CCH-02 / M1) — the newest
--     `provider_type = 'nudge'` assistant message inside the rolling window.
--
-- The pre-existing `(conversation_id, created_at)` index does not cover the
-- `role` / `provider_type` filter, so Postgres gathered every assistant row
-- in the user's threads and sorted. `coach_messages` grows unbounded, and the
-- FAB poll fires on every authenticated page with refetch-on-focus.
--
-- This index orders by `created_at DESC` after `(conversation_id, role)` so
-- the planner can do an index-backed per-conversation merge for the
-- newest-first reads. Additive; no data touched.
--
-- Reversibility (down):
--   DROP INDEX IF EXISTS "coach_messages_conversation_id_role_created_at_idx";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "coach_messages_conversation_id_role_created_at_idx"
  ON "coach_messages"("conversation_id", "role", "created_at" DESC);
