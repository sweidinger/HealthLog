-- HealthLog demo medications for apps01 — canonical ids the 1-year extender
-- (scripts/seed-demo-extend-1y.sql) references for its intake history.
-- Idempotent. Creates the two demo meds + schedules so the extender's
-- medication_intake_events FK resolves and the medication cards/compliance
-- surfaces populate. Demo user id is the canonical seeded id.
--
-- Run:  ssh apps-01 'docker exec -i <db-container> psql -U healthlog -d healthlog' < scripts/seed-demo-meds-apps01.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = 'usr_demo_cf31025295714ece8d91f5af13afd76d') THEN
    RAISE EXCEPTION 'seed-demo-meds: demo user not found';
  END IF;
END $$;

-- ── Med A — Mounjaro (GLP-1, weekly on Sundays @ 08:00) ────────────
INSERT INTO medications
  (id, user_id, name, dose, treatment_class, doses_per_unit, active, notifications_enabled, starts_on, created_at, updated_at)
VALUES
  ('cmq2lzjqh005x01nrys2crzg9', 'usr_demo_cf31025295714ece8d91f5af13afd76d',
   'Mounjaro', '5 mg', 'GLP1', 4, true, true,
   (NOW() - INTERVAL '380 days')::date, NOW() - INTERVAL '380 days', NOW())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, dose = EXCLUDED.dose, treatment_class = EXCLUDED.treatment_class,
  doses_per_unit = EXCLUDED.doses_per_unit, active = true, starts_on = EXCLUDED.starts_on,
  updated_at = NOW();

INSERT INTO medication_schedules
  (id, medication_id, window_start, window_end, label, times_of_day, days_of_week, rrule)
VALUES
  ('sched_demo_medA_mounjaro', 'cmq2lzjqh005x01nrys2crzg9',
   '08:00', '10:00', 'Wöchentlich', ARRAY['08:00'], '7', 'FREQ=WEEKLY;BYDAY=SU')
ON CONFLICT (id) DO UPDATE SET
  window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
  label = EXCLUDED.label, times_of_day = EXCLUDED.times_of_day,
  days_of_week = EXCLUDED.days_of_week, rrule = EXCLUDED.rrule;

-- ── Med B — Ramipril (twice daily @ 08:00 + 18:00) ─────────────────
INSERT INTO medications
  (id, user_id, name, dose, treatment_class, active, notifications_enabled, starts_on, created_at, updated_at)
VALUES
  ('cmq2m0mzk006101nrdpijbij0', 'usr_demo_cf31025295714ece8d91f5af13afd76d',
   'Ramipril', '5 mg', 'GENERIC', true, true,
   (NOW() - INTERVAL '380 days')::date, NOW() - INTERVAL '380 days', NOW())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, dose = EXCLUDED.dose, treatment_class = EXCLUDED.treatment_class,
  active = true, starts_on = EXCLUDED.starts_on, updated_at = NOW();

INSERT INTO medication_schedules
  (id, medication_id, window_start, window_end, label, times_of_day, days_of_week, rrule)
VALUES
  ('sched_demo_medB_ramipril', 'cmq2m0mzk006101nrdpijbij0',
   '08:00', '18:00', 'Morgens & Abends', ARRAY['08:00','18:00'], NULL, 'FREQ=DAILY')
ON CONFLICT (id) DO UPDATE SET
  window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
  label = EXCLUDED.label, times_of_day = EXCLUDED.times_of_day,
  days_of_week = EXCLUDED.days_of_week, rrule = EXCLUDED.rrule;

COMMIT;

\echo === demo meds ===
SELECT id, name, dose, treatment_class, active FROM medications
WHERE user_id = 'usr_demo_cf31025295714ece8d91f5af13afd76d' ORDER BY name;
