-- v1.27.9 — screening-score enum values for the two new self-report
-- instruments: the WHO-5 well-being index (percentage 0–100, raw sum × 4)
-- and the Sleep Condition Indicator (total 0–32, higher = better sleep).
--
-- Same contract as PHQ9_SCORE / GAD7_SCORE (0213/0225 lineage): the value is
-- server-derived from a completed MentalHealthAssessment and written as a
-- `COMPUTED`-source Measurement row, so clients can never forge a trend point
-- through the measurement write surfaces. Additive, idempotent.
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WHO5_SCORE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'SCI_SCORE';

-- The assessment discriminator learns the two new instruments (0213 created
-- it with PHQ9/GAD7 only).
ALTER TYPE "assessment_instrument" ADD VALUE IF NOT EXISTS 'WHO5';
ALTER TYPE "assessment_instrument" ADD VALUE IF NOT EXISTS 'SCI';
