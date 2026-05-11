-- v1.4.23 H3 reconcile (senior-dev review): the v1.4.23 H7 Coach
-- feedback route decrypted assistant prose and wrote it as plaintext
-- into `recommendation_feedback.recommendation_text`. The same prose
-- already lives encrypted-at-rest in `coach_messages.encrypted_content`
-- (AES-256-GCM via `@/lib/crypto`), so backups captured the leak and
-- the Coach surface's encryption-at-rest invariant was silently
-- broken for every rated message.
--
-- Fix: drop the prose-snapshot dedup key for Coach rows in favour of a
-- foreign-key reference to the source message. The aggregator never
-- reads the prose anyway (it slices on structured columns only) and
-- the admin view never surfaces user prose, so the only consumer is
-- the unique-index dedup — which a per-message FK satisfies cleanly.
--
-- For the existing recommendation surface (`target_type = 'recommendation'`)
-- the prose is already plaintext on the wire (recommendations are not
-- encrypted) and the dedup key still relies on `recommendation_text`,
-- so we keep that column nullable instead of dropping it. The
-- recommendation route continues to write the snapshot; the Coach
-- route stops writing the column entirely.
--
-- Idempotent: every statement uses `IF [NOT] EXISTS` so a re-run after
-- a partial failure (or in environments where the table predates this
-- migration in a different state) is safe.

-- 1. Add the FK column. Nullable because the recommendation surface
--    rows do not have a coach message — they reference an unencrypted
--    insight recommendation by id only.
ALTER TABLE "recommendation_feedback"
  ADD COLUMN IF NOT EXISTS "coach_message_id" TEXT;

-- 2. FK to coach_messages with cascade delete: removing a coach
--    message drops the rating row too (the rating is meaningless
--    without the source message). A separate constraint name keeps the
--    statement re-runnable via a guard query.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'recommendation_feedback_coach_message_id_fkey'
  ) THEN
    ALTER TABLE "recommendation_feedback"
      ADD CONSTRAINT "recommendation_feedback_coach_message_id_fkey"
      FOREIGN KEY ("coach_message_id") REFERENCES "coach_messages"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "recommendation_feedback_coach_message_id_idx"
  ON "recommendation_feedback" ("coach_message_id");

-- 3. Backfill: for every coach-target row whose recommendation_id
--    happens to match a coach_messages.id (every v1.4.23 row, by
--    construction — the H7 route stamped the message id into
--    recommendation_id), copy the id into the new column.
UPDATE "recommendation_feedback" rf
SET "coach_message_id" = rf."recommendation_id"
WHERE rf."target_type" = 'coach'
  AND rf."coach_message_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "coach_messages" cm WHERE cm."id" = rf."recommendation_id"
  );

-- 4. Null out the leaked plaintext for any coach rows that landed
--    pre-migration. The aggregator does not read this column, so the
--    blank value has no functional consequence — but it removes the
--    plaintext from on-disk pages on the next VACUUM.
UPDATE "recommendation_feedback"
SET "recommendation_text" = NULL
WHERE "target_type" = 'coach'
  AND "recommendation_text" IS NOT NULL;

-- 5. Make recommendation_text nullable. The recommendation surface
--    still populates it (and the unique key
--    `rec_feedback_user_rec_text_key` still defends against duplicate
--    ratings of the same recommendation snapshot); the coach surface
--    leaves it NULL forever.
ALTER TABLE "recommendation_feedback"
  ALTER COLUMN "recommendation_text" DROP NOT NULL;

-- 6. Coach-only dedup key: one rating per (user, message). Partial so
--    it does not interfere with the recommendation flow's existing
--    `(user_id, recommendation_id, recommendation_text)` unique key.
CREATE UNIQUE INDEX IF NOT EXISTS "rec_feedback_user_coach_message_key"
  ON "recommendation_feedback" ("user_id", "coach_message_id")
  WHERE "target_type" = 'coach' AND "coach_message_id" IS NOT NULL;
