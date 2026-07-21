-- Fork ADHS Stage B.2 — medication effect-window check-in reminder.
--
-- Adds the per-(user, medication, local date, window) dispatch ledger that
-- makes the every-15-min reminder cron idempotent: each effect window
-- ("EFFECT" a while after intake, "REBOUND" the afternoon rebound) fires at
-- most once per local day. Modeled 1:1 on `mood_reminder_dispatches`.
--
-- Additive: a brand-new table with no back-fill and no change to any
-- existing row. Safe on PG16.

CREATE TABLE IF NOT EXISTS "medication_checkin_reminder_dispatches" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "medication_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "dispatched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "medication_checkin_reminder_dispatches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "medication_checkin_reminder_dispatches_user_med_date_window_key"
  ON "medication_checkin_reminder_dispatches"("user_id", "medication_id", "date", "window");

CREATE INDEX IF NOT EXISTS "medication_checkin_reminder_dispatches_user_id_dispatched_at_idx"
  ON "medication_checkin_reminder_dispatches"("user_id", "dispatched_at");

DO $$ BEGIN
  ALTER TABLE "medication_checkin_reminder_dispatches"
    ADD CONSTRAINT "medication_checkin_reminder_dispatches_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
