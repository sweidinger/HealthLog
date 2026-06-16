-- v1.19.0 — reminder-engine fields for the "one engine" unification.
--
-- Two additive columns on `measurement_reminders` so the AI coach can
-- produce cadence reminders into the SAME table the Vorsorge surface uses
-- (one model, one recurrence helper, one cron, one create endpoint — not a
-- second "coach reminder" table):
--
--   * `ends_on` (nullable timestamp) — an optional course-window end. NULL =
--     open-ended cadence (the existing behaviour, every current row). Non-NULL
--     bounds a finite cadence so a Coach "measure BP morning+evening for a
--     week" self-expires: the recurrence engine stops producing occurrences
--     past this instant (the `medication.ends_on` precedent the engine already
--     supports).
--
--   * `origin` (enum `reminder_origin`, default `VORSORGE`) — provenance.
--     `VORSORGE` = the user created it through the Vorsorge surface (the
--     existing behaviour; backfilled onto every current row by the column
--     default). `COACH` = the coach minted it from an evidence-based cadence
--     suggestion. Lets the UI label provenance and lets Coach dedupe its own
--     suggestions.
--
-- No backfill needed: `ends_on` defaults NULL (open-ended) and `origin`
-- defaults `VORSORGE`, so every existing reminder keeps its current
-- behaviour. No new index — the cron already rides `(user_id, next_due_at)`
-- and these two columns are read alongside the row, never scanned on.
--
-- Idempotent guards (`IF NOT EXISTS` / `DO $$`) so reruns are safe on prod.
--
-- Reversibility (down):
--   ALTER TABLE "measurement_reminders" DROP COLUMN IF EXISTS "origin";
--   ALTER TABLE "measurement_reminders" DROP COLUMN IF EXISTS "ends_on";
--   DROP TYPE IF EXISTS "reminder_origin";
-- A roll-back loses the coach/vorsorge distinction + any course-window end
-- (every reminder falls back to open-ended user-created), which is the safe
-- default — no data is destroyed.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "reminder_origin" AS ENUM ('VORSORGE', 'COACH');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "measurement_reminders"
    ADD COLUMN IF NOT EXISTS "ends_on" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "origin" "reminder_origin" NOT NULL DEFAULT 'VORSORGE';
