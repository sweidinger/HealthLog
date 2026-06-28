-- v1.25 — durable medication pause intervals (H-MED1).
--
-- The `medications.paused_at` column is a single live marker: resume clears
-- it, so the paused window is irrecoverable once the medication resumes.
-- After a resume the compliance denominator spanned created_at..now and every
-- paused day's expected slot collapsed to "missed", deflating adherence.
--
-- `medication_pause_eras` records each pause as its own durable row: a pause
-- stamps an open era (`resumed_at` NULL), resume closes the latest open era
-- (`resumed_at` = now). The compliance engine drops expected dose slots whose
-- anchor falls inside any `[paused_at, resumed_at ?? now)` interval so a
-- resumed medication never counts the paused days as missed. The `paused_at`
-- marker column on `medications` is left intact — current readers depend on it.
CREATE TABLE "medication_pause_eras" (
    "id" TEXT NOT NULL,
    "medication_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "paused_at" TIMESTAMPTZ(6) NOT NULL,
    "resumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medication_pause_eras_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "medication_pause_eras_medication_id_idx" ON "medication_pause_eras"("medication_id");

CREATE INDEX "medication_pause_eras_user_id_idx" ON "medication_pause_eras"("user_id");

ALTER TABLE "medication_pause_eras" ADD CONSTRAINT "medication_pause_eras_medication_id_fkey" FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "medication_pause_eras" ADD CONSTRAINT "medication_pause_eras_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
