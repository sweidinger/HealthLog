-- v1.18.9 — qualitative lab results (positive/negative/borderline serology).
--
-- A LabResult was numeric-only (`value` NOT NULL). Qualitative findings
-- ("Hepatitis Bs-Antigen: negativ") have no number to store. This migration is
-- ADDITIVE and preserves every existing numeric row:
--
--   1. `value` becomes nullable so a qualitative row can omit it. Existing rows
--      keep their numeric value untouched (DROP NOT NULL never rewrites data).
--   2. `value_text` is added (nullable) to hold the qualitative result string.
--
-- A row is QUANTITATIVE when `value IS NOT NULL`, QUALITATIVE when
-- `value_text IS NOT NULL`. The application layer enforces the exclusive-or.
ALTER TABLE "lab_results" ALTER COLUMN "value" DROP NOT NULL;
ALTER TABLE "lab_results" ADD COLUMN "value_text" text;
