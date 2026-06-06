-- Additive: at-rest envelope column for the intent-revealing cycle day-log
-- fields. Populated INSTEAD of the plaintext columns when
-- CycleProfile.sensitive_category_encryption is ON; the plaintext columns
-- are then NULL. AES-256-GCM ciphertext, decrypted fail-soft on read.
ALTER TABLE "cycle_day_logs" ADD COLUMN "sensitive_encrypted" TEXT;
