-- v1.18.1 — structural accept-dedup for COACH-minted measurement reminders.
--
-- The Coach can mint a `MeasurementReminder` (origin: COACH) from an
-- evidence-based cadence suggestion. The accept endpoint already does a
-- read-then-create dedup, but a read-then-create is racy: two near-simultaneous
-- accepts (a re-tap, or a stale card replayed) can both pass the existence
-- check and create twins. Close the race at the database with a PARTIAL unique
-- index: at most one LIVE COACH reminder per (user, metric). VORSORGE rows are
-- unaffected, and a soft-deleted (deleted_at IS NOT NULL) COACH row never
-- blocks a fresh accept of the same cadence.
--
-- Defensive pre-clean: should any duplicate live COACH rows already exist
-- (created before this constraint landed), keep the most recently created one
-- and tombstone the rest so the unique index can be built without error.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, measurement_type
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM "measurement_reminders"
  WHERE origin = 'COACH' AND deleted_at IS NULL
)
UPDATE "measurement_reminders" m
SET deleted_at = NOW()
FROM ranked
WHERE m.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX "measurement_reminders_coach_metric_live_key"
  ON "measurement_reminders" ("user_id", "measurement_type")
  WHERE origin = 'COACH' AND deleted_at IS NULL;
