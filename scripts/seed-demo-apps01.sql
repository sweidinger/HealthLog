-- HealthLog demo seed for apps01 — v1.15 (cycle-inclusive, FEMALE demo).
--
-- Creates / refreshes the `demo` account as a WOMAN with cycle tracking on,
-- NOW()-anchored + idempotent (re-runnable: wipes the demo user's rows first).
-- Showcases vitals + mood + the v1.15 cycle vertical (5 cycles, daily BBT with
-- a biphasic shift, mucus/OPK progression, period flow, phase-clustered
-- symptoms), plus phase-dependent RHR/HRV/sleep so the phase×vitals insights
-- board surfaces real findings. role=USER (login is open on prod; an
-- admin demo would be a risk). AI insights are generated separately afterwards.
--
-- Run:  ssh apps-01 'docker exec -i <db-container> psql -U healthlog -d healthlog' < scripts/seed-demo-apps01.sql

BEGIN;

-- ── User (FEMALE, USER role) ──────────────────────────────────────
INSERT INTO users (id, username, email, password_hash, role, height_cm, date_of_birth, gender, timezone, locale, onboarding_completed_at, created_at, updated_at)
SELECT 'usr_demo_cf31025295714ece8d91f5af13afd76d',
       'demo', 'demo@healthlog.app',
       '$argon2id$v=19$m=19456,t=2,p=1$3KvrEIuI5UnwG53GPbS71w$mL8ZQotIXn9iLFIw3yHXbh6SitX1w7TXKI5ahWcKkF8',
       'USER', 168, TIMESTAMP '1992-03-15', 'FEMALE', 'Europe/Berlin', 'en', NOW(), NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'demo');

UPDATE users SET
  gender = 'FEMALE', role = 'USER', height_cm = 168, date_of_birth = TIMESTAMP '1992-03-15',
  password_hash = '$argon2id$v=19$m=19456,t=2,p=1$3KvrEIuI5UnwG53GPbS71w$mL8ZQotIXn9iLFIw3yHXbh6SitX1w7TXKI5ahWcKkF8',
  onboarding_completed_at = NOW(), timezone = 'Europe/Berlin', locale = 'en', updated_at = NOW()
WHERE username = 'demo';

CREATE TEMP TABLE _demo AS SELECT id AS user_id FROM users WHERE username = 'demo' LIMIT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _demo) THEN
    RAISE EXCEPTION 'seed-demo-apps01: demo user not resolved';
  END IF;
END $$;

-- ── Wipe prior demo rows (idempotent) ─────────────────────────────
DELETE FROM cycle_symptom_links WHERE day_log_id IN (SELECT id FROM cycle_day_logs WHERE user_id IN (SELECT user_id FROM _demo));
DELETE FROM cycle_day_logs   WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM cycle_predictions WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM menstrual_cycles  WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM mood_entries      WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM measurements      WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM measurement_rollups WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM mood_entry_rollups  WHERE user_id IN (SELECT user_id FROM _demo);

-- ── Cycle profile (tracking ON) ───────────────────────────────────
INSERT INTO cycle_profiles (id, user_id, goal, cycle_tracking_enabled, typical_cycle_length, typical_period_length, luteal_phase_length, prediction_enabled, raw_chart_mode, discreet_notifications, sensitive_category_encryption, created_at, updated_at)
SELECT 'cp_' || replace(gen_random_uuid()::text, '-', ''), user_id, 'GENERAL_HEALTH', true, 28, 5, 14, true, false, false, true, NOW(), NOW()
FROM _demo
WHERE NOT EXISTS (SELECT 1 FROM cycle_profiles cp JOIN _demo d ON cp.user_id = d.user_id);

UPDATE cycle_profiles SET
  cycle_tracking_enabled = true, goal = 'GENERAL_HEALTH', prediction_enabled = true,
  typical_cycle_length = 28, typical_period_length = 5, luteal_phase_length = 14, updated_at = NOW()
WHERE user_id IN (SELECT user_id FROM _demo);

-- ── Measurements (90-day sliding window, phase-aware) ─────────────
-- cycleDay(d) = ((128 - d) % 28) + 1 ; luteal = cycleDay > 13.
WITH demo AS (SELECT user_id FROM _demo), days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, glucose_context, measured_at, created_at, updated_at)
SELECT 'm_' || replace(gen_random_uuid()::text, '-', ''), (SELECT user_id FROM demo), v.type::measurement_type, v.value, v.unit, 'MANUAL'::measurement_source,
       v.gc::glucose_context,
       NOW() - (d || ' days')::interval - (random() * 5 || ' hours')::interval,
       NOW() - (d || ' days')::interval, NOW() - (d || ' days')::interval
FROM days,
LATERAL (
  SELECT ((128 - d) % 28) + 1 AS cd
) c,
LATERAL (VALUES
  ('WEIGHT',  round((66.0 - (90 - d) * 0.011 + (random() - 0.5) * 0.5)::numeric, 1)::float8, 'kg', NULL),
  ('BLOOD_PRESSURE_SYS', round((116 + (random() - 0.5) * 8)::numeric, 0)::float8, 'mmHg', NULL),
  ('BLOOD_PRESSURE_DIA', round((74 + (random() - 0.5) * 6)::numeric, 0)::float8, 'mmHg', NULL),
  ('PULSE', round((68 + (random() - 0.5) * 8)::numeric, 0)::float8, 'bpm', NULL),
  ('RESTING_HEART_RATE', round((56 + (CASE WHEN c.cd > 13 THEN 3 ELSE 0 END) + (random() - 0.5) * 3)::numeric, 0)::float8, 'bpm', NULL),
  ('HEART_RATE_VARIABILITY', round((68 - (CASE WHEN c.cd > 13 THEN 7 ELSE 0 END) + (random() - 0.5) * 6)::numeric, 0)::float8, 'ms', NULL),
  ('SLEEP_DURATION', round((445 - (CASE WHEN c.cd > 13 THEN 18 ELSE 0 END) + (random() - 0.5) * 40)::numeric, 0)::float8, 'minutes', NULL),
  ('ACTIVITY_STEPS', round((8200 + (random() - 0.5) * 3500)::numeric, 0)::float8, 'steps', NULL),
  ('BODY_FAT', round((27.5 - (90 - d) * 0.006 + (random() - 0.5) * 0.4)::numeric, 1)::float8, '%', NULL),
  ('BODY_TEMPERATURE', round(((CASE WHEN c.cd <= 13 THEN 36.36 ELSE 36.73 END) + (random() - 0.5) * 0.08)::numeric, 2)::float8, 'celsius', NULL),
  ('BLOOD_GLUCOSE', round((92 + (random() - 0.5) * 18)::numeric, 0)::float8, 'mg/dL', 'FASTING')
) AS v(type, value, unit, gc);

-- ── Mood (90 days, luteal dip) ────────────────────────────────────
WITH demo AS (SELECT user_id FROM _demo), days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO mood_entries (id, user_id, date, mood, score, source, mood_logged_at, synced_at, tz, sync_version, created_at, updated_at)
SELECT 'mo_' || replace(gen_random_uuid()::text, '-', ''), (SELECT user_id FROM demo),
       to_char(NOW() - (d || ' days')::interval, 'YYYY-MM-DD'),
       CASE s.score WHEN 1 THEN 'LAUSIG' WHEN 2 THEN 'SCHLECHT' WHEN 3 THEN 'OKAY' WHEN 4 THEN 'GUT' ELSE 'SUPER_GUT' END,
       s.score, 'MANUAL',
       NOW() - (d || ' days')::interval - (random() * 6 || ' hours')::interval,
       NOW() - (d || ' days')::interval, 'Europe/Berlin', 0,
       NOW() - (d || ' days')::interval, NOW() - (d || ' days')::interval
FROM days,
LATERAL (SELECT ((128 - d) % 28) + 1 AS cd) c,
LATERAL (
  SELECT GREATEST(1, LEAST(5,
    round((CASE WHEN c.cd > 23 THEN 2.6 WHEN c.cd > 13 THEN 3.3 ELSE 3.9 END) + (random() - 0.5) * 1.6)::int
  )) AS score
) s;

-- ── Menstrual cycles (5, NOW-anchored; last open) ─────────────────
WITH offs AS (SELECT unnest(ARRAY[128, 100, 72, 44, 16]) AS off)
INSERT INTO menstrual_cycles (id, user_id, start_date, end_date, period_end_date, length_days, ovulation_date, ovulation_confirmed, is_predicted, tz, created_at, updated_at)
SELECT 'mc_' || replace(gen_random_uuid()::text, '-', ''), (SELECT user_id FROM _demo),
       to_char(NOW() - (off || ' days')::interval, 'YYYY-MM-DD'),
       CASE WHEN off = 16 THEN NULL ELSE to_char(NOW() - ((off - 27) || ' days')::interval, 'YYYY-MM-DD') END,
       to_char(NOW() - ((off - 4) || ' days')::interval, 'YYYY-MM-DD'),
       CASE WHEN off = 16 THEN NULL ELSE 28 END,
       to_char(NOW() - ((off - 13) || ' days')::interval, 'YYYY-MM-DD'),
       true, false, 'Europe/Berlin', NOW(), NOW()
FROM offs;

-- ── Cycle day-logs (128 days) + phase-clustered symptom links ─────
WITH demo AS (SELECT user_id FROM _demo),
gen AS (
  SELECT d, ((128 - d) % 28) + 1 AS cd, to_char(NOW() - (d || ' days')::interval, 'YYYY-MM-DD') AS dstr
  FROM generate_series(0, 127) AS d
),
ins AS (
  INSERT INTO cycle_day_logs (id, user_id, date, flow, basal_body_temp_c, cervical_mucus, ovulation_test, source, tz, sync_version, created_at, updated_at)
  SELECT 'cdl_' || replace(gen_random_uuid()::text, '-', ''), (SELECT user_id FROM demo), g.dstr,
    (CASE g.cd WHEN 1 THEN 'MEDIUM' WHEN 2 THEN 'HEAVY' WHEN 3 THEN 'MEDIUM' WHEN 4 THEN 'LIGHT' WHEN 5 THEN 'SPOTTING' ELSE NULL END)::flow_level,
    round(((CASE WHEN g.cd <= 13 THEN 36.36 ELSE 36.73 END) + (random() - 0.5) * 0.08)::numeric, 2)::float8,
    (CASE WHEN g.cd BETWEEN 1 AND 5 THEN NULL WHEN g.cd BETWEEN 6 AND 9 THEN 'STICKY' WHEN g.cd BETWEEN 10 AND 12 THEN 'CREAMY' WHEN g.cd BETWEEN 13 AND 14 THEN 'EGG_WHITE' WHEN g.cd BETWEEN 15 AND 16 THEN 'WATERY' ELSE 'DRY' END)::cervical_mucus,
    (CASE WHEN g.cd = 13 THEN 'POSITIVE_LH_SURGE' WHEN g.cd IN (11, 12, 14) THEN 'NEGATIVE' ELSE NULL END)::ovulation_test,
    'MANUAL'::measurement_source, 'Europe/Berlin', 0,
    NOW() - (g.d || ' days')::interval, NOW() - (g.d || ' days')::interval
  FROM gen g
  RETURNING id, date
),
link_menstrual AS (
  INSERT INTO cycle_symptom_links (day_log_id, symptom_id, severity, created_at)
  SELECT ins.id, s.id, (2 + floor(random() * 3))::int, NOW()
  FROM ins JOIN gen g ON g.dstr = ins.date
  CROSS JOIN LATERAL (SELECT id FROM cycle_symptoms WHERE user_id IS NULL AND key IN ('cramps', 'headache', 'fatigue')) s
  WHERE g.cd BETWEEN 1 AND 3
)
INSERT INTO cycle_symptom_links (day_log_id, symptom_id, severity, created_at)
SELECT ins.id, s.id, (1 + floor(random() * 3))::int, NOW()
FROM ins JOIN gen g ON g.dstr = ins.date
CROSS JOIN LATERAL (SELECT id FROM cycle_symptoms WHERE user_id IS NULL AND key IN ('mood_swings', 'bloating', 'breast_tenderness')) s
WHERE g.cd BETWEEN 24 AND 28;

COMMIT;

-- ── Summary ───────────────────────────────────────────────────────
SELECT 'demo user'    AS what, id FROM users WHERE username = 'demo';
SELECT 'measurements' AS what, count(*) FROM measurements   WHERE user_id = (SELECT id FROM users WHERE username = 'demo');
SELECT 'mood'         AS what, count(*) FROM mood_entries    WHERE user_id = (SELECT id FROM users WHERE username = 'demo');
SELECT 'cycles'       AS what, count(*) FROM menstrual_cycles WHERE user_id = (SELECT id FROM users WHERE username = 'demo');
SELECT 'day_logs'     AS what, count(*) FROM cycle_day_logs  WHERE user_id = (SELECT id FROM users WHERE username = 'demo');
SELECT 'symptom_links' AS what, count(*) FROM cycle_symptom_links l JOIN cycle_day_logs dl ON l.day_log_id = dl.id WHERE dl.user_id = (SELECT id FROM users WHERE username = 'demo');
