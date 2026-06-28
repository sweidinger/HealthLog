-- v1.25 — encrypt medication free-text notes at rest.
--
-- Adds the AES-256-GCM ciphertext columns for the three medication
-- free-text fields that were still plaintext: the side-effect note
-- (`medication_side_effects.notes`), the dose-change titration note
-- (`medication_dose_changes.note`), and the inventory-item note
-- (`medication_inventory_items.notes`). These were the last plaintext
-- PHI columns left after the v1.23 note-encryption rollout.
--
-- STORAGE CONVENTION: Bytes (`bytea`), matching the dominant free-text
-- encrypted-note convention already in the schema (mood_entries.note_
-- encrypted, measurements.notes_encrypted, illness_day_logs.note_encrypted,
-- labs.note_encrypted, coach_*.{...}_encrypted) — the `encrypt()`
-- ciphertext string stored UTF-8 as `bytea`, the shape the rotation
-- script's `rotateBytesColumn` already covers. All three columns are
-- registered in ENCRYPTED_COLUMNS + the rotation script in the same change.
--
-- This migration is ADDITIVE ONLY. The legacy plaintext columns
-- (`medication_side_effects.notes`, `medication_dose_changes.note`,
-- `medication_inventory_items.notes`) are intentionally NOT dropped here:
-- an idempotent, transactional, fail-closed boot-time job encrypts the
-- existing rows (plaintext -> ciphertext, then nulls the plaintext) so the
-- read path can fall back to plaintext for not-yet-migrated rows. Dropping
-- the plaintext columns is a deliberate FOLLOW-UP release, once the backfill
-- reports zero remaining plaintext-but-no-ciphertext rows — the same
-- boundary the encryption-key-rotation playbook uses before dropping a
-- legacy key.
ALTER TABLE "medication_side_effects"
  ADD COLUMN IF NOT EXISTS "notes_encrypted" BYTEA;

ALTER TABLE "medication_dose_changes"
  ADD COLUMN IF NOT EXISTS "note_encrypted" BYTEA;

ALTER TABLE "medication_inventory_items"
  ADD COLUMN IF NOT EXISTS "notes_encrypted" BYTEA;
