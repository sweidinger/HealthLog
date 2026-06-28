-- v1.25 — clinical-signals wave: physical / clinical measurement types.
--
-- Grip strength (EWGSOP2 sarcopenia limb), pain Numeric Rating Scale (0–10),
-- waist circumference (WHO STEPS), and the waist-to-height ratio (WHtR). Each
-- is a first-class numeric Measurement type; bands/units are applied at the
-- display edge from the signal registry. ADD VALUE IF NOT EXISTS is idempotent.
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'GRIP_STRENGTH';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'PAIN_NRS';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WAIST_CIRCUMFERENCE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WAIST_TO_HEIGHT';
