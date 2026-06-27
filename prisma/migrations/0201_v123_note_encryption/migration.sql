-- v1.23 — encrypt free-text health notes at rest.
--
-- Adds the AES-256-GCM ciphertext columns for the two free-text health-note
-- fields that were still plaintext (`mood_entries.note`, `measurements.notes`).
--
-- STORAGE CONVENTION: Bytes (`bytea`), matching the dominant free-text
-- encrypted-note convention already in the schema — illness_day_logs.note_
-- encrypted, cycle_day_logs.notes_encrypted (string-kind), labs.note_encrypted,
-- coach_*.{...}_encrypted are all the shared-codec shape (the `encrypt()`
-- ciphertext string stored UTF-8 as `bytea`). `bytea` is chosen here because
-- the comparable note columns (IllnessDayLog / LabResult) use it and the
-- rotation script's `rotateBytesColumn` already covers that shape with least
-- friction. Both columns are registered in ENCRYPTED_COLUMNS + the rotation
-- script in the same change.
--
-- This migration is ADDITIVE ONLY. The legacy plaintext columns
-- (`mood_entries.note`, `measurements.notes`) are intentionally NOT dropped
-- here: an idempotent, transactional, fail-closed boot-time job encrypts the
-- existing rows (plaintext -> ciphertext, then nulls the plaintext) so the
-- read path can fall back to plaintext for not-yet-migrated rows. Dropping the
-- plaintext columns is a deliberate FOLLOW-UP release, once the backfill
-- reports zero remaining plaintext-but-no-ciphertext rows — the same boundary
-- the encryption-key-rotation playbook uses before dropping a legacy key.
ALTER TABLE "mood_entries"
  ADD COLUMN IF NOT EXISTS "note_encrypted" BYTEA;

ALTER TABLE "measurements"
  ADD COLUMN IF NOT EXISTS "notes_encrypted" BYTEA;
