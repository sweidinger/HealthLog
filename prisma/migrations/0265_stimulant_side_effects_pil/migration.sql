-- Stimulant side-effect set expanded to the package-leaflet (PIL) reality.
--
-- Stage A of the ADHS tuning: the Phase-2 stimulant set (v0264) was a minimal
-- starter; this adds the remaining daily-relevant, self-reportable effects the
-- Lisdexamfetamine leaflet lists as very-common / common — six new entries
-- under the existing stimulant categories (activation: tremor, tics, sweating;
-- mood: anxiety, mood swings, fatigue). Purely additive enum growth, no table
-- change, no backfill; GLP-1 rows unaffected. The entry -> category map + the
-- per-class visibility live in src/lib/medications/side-effects/taxonomy.ts.
-- Forward-only. Safe on PostgreSQL 16 (no statement below reads the new values).

ALTER TYPE "medication_side_effect_entry" ADD VALUE 'TREMOR';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'TICS';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'SWEATING';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'ANXIETY';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'MOOD_SWINGS';
ALTER TYPE "medication_side_effect_entry" ADD VALUE 'FATIGUE';
