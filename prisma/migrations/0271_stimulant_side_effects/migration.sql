-- Stimulant side-effect logbook: class-scoped taxonomy for non-GLP-1 /
-- oral medications (e.g. an oral stimulant titration).
--
-- Purely additive enum growth — no table, column, or backfill change. A new
-- treatment class (STIMULANT), three stimulant surface categories, and ten
-- stimulant entries. GLP-1 rows are unaffected; the entry -> category map and
-- the per-class visibility (which class sees which categories) live in
-- src/lib/medications/side-effects/taxonomy.ts. Forward-only.
--
-- ALTER TYPE ... ADD VALUE runs fine on the PostgreSQL 16 target (the "cannot
-- use a new enum value in the same transaction" rule does not apply here — no
-- statement below reads the new values).

ALTER TYPE "medication_category" ADD VALUE 'STIMULANT';

ALTER TYPE "medication_side_effect_category" ADD VALUE 'STIMULANT_ACTIVATION';
ALTER TYPE "medication_side_effect_category" ADD VALUE 'STIMULANT_SOMATIC';
ALTER TYPE "medication_side_effect_category" ADD VALUE 'STIMULANT_MOOD';

ALTER TYPE "medication_side_effect_entry" ADD VALUE 'INSOMNIA';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'PALPITATIONS';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'RESTLESSNESS';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'REDUCED_APPETITE';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'DRY_MOUTH';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'BRUXISM';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'HEADACHE';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'IRRITABILITY';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'EMOTIONAL_BLUNTING';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'AFTERNOON_REBOUND';
