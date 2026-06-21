-- v1.19.0 — full Withings ECG waveform capture.
--
-- v1.18.11 captured only the device's atrial-fibrillation *verdict* per
-- on-device ECG (one IRREGULAR_RHYTHM_NOTIFICATION measurement EVENT row).
-- This adds the raw ECG **waveform** so a real trace can later be rendered.
--
-- One additive table, `ecg_recordings`:
--
--   * `waveform_encrypted` (BYTEA) holds the AES-256-GCM ciphertext of the
--     JSON-encoded micro-volt sample array (Withings Heart `get` `body.signal`)
--     — the `*Encrypted` Bytes convention (the coach_messages.encrypted_content
--     precedent). The waveform NEVER lands as plaintext (fail-closed crypto).
--   * `sampling_frequency` (Hz), `sample_count`, `duration_seconds`, `lead`,
--     and `average_heart_rate` stay plaintext descriptors so a renderer can
--     read them without a per-row decrypt.
--   * `rhythm_classification` snapshots the paired EVENT row's AFib verdict;
--     `measurement_id` FKs back to that row (ON DELETE SET NULL — the trace
--     survives a re-keyed/removed EVENT row).
--
-- Idempotency: a re-sync of the same recording upserts in place via the
-- unique `(user_id, source, external_recording_id)` (Withings `signalid`,
-- or a `ts-<unix>` fallback).
--
-- Additive; no existing row touched. Idempotent guards (`IF NOT EXISTS` /
-- `DO $$`) so reruns are safe on prod.
--
-- Reversibility (down):
--   DROP TABLE IF EXISTS "ecg_recordings";
-- The waveform store is self-contained — no other domain depends on it.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ecg_recordings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source" "measurement_source" NOT NULL DEFAULT 'WITHINGS',
    "external_recording_id" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "waveform_encrypted" BYTEA NOT NULL,
    "sampling_frequency" INTEGER NOT NULL,
    "sample_count" INTEGER NOT NULL,
    "duration_seconds" DOUBLE PRECISION,
    "lead" TEXT,
    "average_heart_rate" INTEGER,
    "rhythm_classification" "rhythm_classification",
    "measurement_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ecg_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ecg_recordings_user_id_source_external_recording_id_key" ON "ecg_recordings"("user_id", "source", "external_recording_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ecg_recordings_user_id_recorded_at_idx" ON "ecg_recordings"("user_id", "recorded_at" DESC);

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ecg_recordings" ADD CONSTRAINT "ecg_recordings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ecg_recordings" ADD CONSTRAINT "ecg_recordings_measurement_id_fkey" FOREIGN KEY ("measurement_id") REFERENCES "measurements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
