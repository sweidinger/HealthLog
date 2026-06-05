-- v1.12.1 — composite read-path indexes.
--
-- P1-2. `AuditLog(user_id, action, created_at desc)`.
-- `status-cache.ts` filters `AuditLog` on `{ userId, action }` ordered
-- by `created_at desc` on every insight-status card mount (7 generators).
-- The table only had `(user_id, created_at)` and `(action, created_at)`,
-- so the planner picked one prefix and re-filtered + re-sorted the other
-- column over the highest-churn table in the app. The three-column index
-- turns both the `findFirst` and the `take:5` into an index-only range
-- scan.
--
-- P1-3. `MoodEntry(user_id, mood_logged_at)`.
-- `mood-aggregates.ts` + `mood-status.ts` query `MoodEntry` by
-- `{ userId, deletedAt: null, moodLoggedAt: { gte } }` ordered by
-- `mood_logged_at desc`. No existing index leads with
-- `(user_id, mood_logged_at)`; the planner used the `user_id` prefix then
-- sorted. Additive, low risk.
--
-- Both are pure `CREATE INDEX IF NOT EXISTS` — additive, no column add,
-- no backfill.

CREATE INDEX IF NOT EXISTS "audit_logs_user_id_action_created_at_idx"
  ON "audit_logs" ("user_id", "action", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "mood_entries_user_id_mood_logged_at_idx"
  ON "mood_entries" ("user_id", "mood_logged_at");
