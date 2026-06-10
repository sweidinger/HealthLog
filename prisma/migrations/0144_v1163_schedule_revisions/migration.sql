-- v1.16.3 — schedule-revision archive (effective dating).
--
-- A medication whose schedule times are edited used to lose its history: the
-- wholesale replace (deleteMany + create) left only the CURRENT rows, so
-- bands for PAST days were minted from the new times — the entire old era
-- read "unscheduled" and the new times' past slots read "missed".
--
-- This table archives each SUPERSEDED schedule state as one revision row
-- covering `[valid_from, valid_until)`. The LIVE rows stay in
-- `medication_schedules`; a revision never describes the current state, so
-- `valid_until` is NOT NULL by construction. `payload` holds the full
-- snapshot of the replaced schedule rows (timesOfDay, windows, cadence
-- fields, doseWindows, label, dose, reminderGraceMinutes) — enough to
-- rebuild the canonical schedule list for era minting.
--
-- `starts_on` stays the global floor: the first era begins at
-- max(medication.created_at, starts_on).
--
-- Additive + non-destructive: a new empty table; no existing row changes.
CREATE TABLE "medication_schedule_revisions" (
    "id" TEXT NOT NULL,
    "medication_id" TEXT NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medication_schedule_revisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "medication_schedule_revisions_medication_id_valid_from_idx"
    ON "medication_schedule_revisions"("medication_id", "valid_from");

ALTER TABLE "medication_schedule_revisions"
    ADD CONSTRAINT "medication_schedule_revisions_medication_id_fkey"
    FOREIGN KEY ("medication_id") REFERENCES "medications"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
