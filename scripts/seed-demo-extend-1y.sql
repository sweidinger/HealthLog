-- HealthLog demo 1-year history extender for apps01.
--
-- WHAT THIS DOES
--   Extends the demo account's data BACKWARD from the existing ~90-day seed
--   (scripts/seed-demo-apps01.sql) to ~365 days of coverage, and adds ~365 days
--   of realistic medication-intake history for the two pre-existing demo meds.
--   It mirrors that seed EXACTLY: same column lists, enum values, NOW()-anchored
--   offset math (cycleDay(d) = ((128 - d) % 28) + 1), cuid/uuid-id style, and the
--   same phase-aware vitals / mood / cycle channels.
--
--   The seed covers offsets 0..89 (measurements + mood), 0..127 (cycle day-logs),
--   and 5 cycles at NOW-offsets {128,100,72,44,16}. This file ADDS ONLY the older
--   tail so nothing is duplicated:
--     - measurements / mood : offsets 90..364 (thinned to every 2nd day past ~180d)
--     - cycle day-logs       : offsets 128..364
--     - menstrual cycles      : 7 more 28-day cycles at offsets 156..352
--     - medication intakes    : ~365d of due slots for both demo meds
--
-- SCOPE + SAFETY
--   - Demo-user-scoped: EVERY statement filters on the hardcoded demo user id.
--   - Idempotent: every INSERT guards on the live unique index via ON CONFLICT
--     DO NOTHING (or a date-offset window that begins past the seed's coverage),
--     so re-running adds nothing new.
--   - NO DDL (no CREATE/ALTER/DROP/TRUNCATE), no changes to any other user,
--     no table-wide DELETE/UPDATE.
--
-- Run:  ssh apps-01 'docker exec -i <db-container> psql -U healthlog -d healthlog' < scripts/seed-demo-extend-1y.sql

\set uid 'usr_demo_cf31025295714ece8d91f5af13afd76d'
\set medA 'cmq2lzjqh005x01nrys2crzg9'  -- Mounjaro: weekly @ 08:00 (rolling 7d)
\set medB 'cmq2m0mzk006101nrdpijbij0'  -- Ramipril: twice daily @ 08:00 + 18:00

BEGIN;

-- Refuse to run if the demo user does not exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = 'usr_demo_cf31025295714ece8d91f5af13afd76d') THEN
    RAISE EXCEPTION 'seed-demo-extend-1y: demo user not found';
  END IF;
END $$;

-- ── Measurements: offsets 90..364, phase-aware (mirrors the seed channels) ─────
-- Thin the deep tail: keep every day for 90..179, every 2nd day for 180..364, to
-- keep row volume sane while still covering the full year. Unique index
-- (user_id, type, measured_at, source, sleep_stage) NULLS NOT DISTINCT — but
-- measured_at carries a random sub-day jitter, so collisions are effectively
-- impossible on a fresh tail; ON CONFLICT DO NOTHING makes re-runs safe anyway.
WITH days AS (
  SELECT d FROM generate_series(90, 364) AS d
  WHERE d < 180 OR (d % 2) = 0
)
INSERT INTO measurements (id, user_id, type, value, unit, source, glucose_context, measured_at, created_at, updated_at)
SELECT 'm_' || replace(gen_random_uuid()::text, '-', ''),
       'usr_demo_cf31025295714ece8d91f5af13afd76d',
       v.type::measurement_type, v.value, v.unit, 'MANUAL'::measurement_source,
       v.gc::glucose_context,
       NOW() - (d || ' days')::interval - (random() * 5 || ' hours')::interval,
       NOW() - (d || ' days')::interval, NOW() - (d || ' days')::interval
FROM days,
LATERAL (SELECT ((128 - d) % 28) + 1 AS cd) c,
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
) AS v(type, value, unit, gc)
ON CONFLICT DO NOTHING;

-- ── Mood: offsets 90..364, luteal dip (mirrors the seed) ───────────────────────
-- Unique index (user_id, date, mood_logged_at). One entry per day, fresh tail.
WITH days AS (SELECT generate_series(90, 364) AS d)
INSERT INTO mood_entries (id, user_id, date, mood, score, source, mood_logged_at, synced_at, tz, sync_version, created_at, updated_at)
SELECT 'mo_' || replace(gen_random_uuid()::text, '-', ''),
       'usr_demo_cf31025295714ece8d91f5af13afd76d',
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
) s
ON CONFLICT DO NOTHING;

-- ── Menstrual cycles: 7 more 28-day cycles, offsets 156..352 ───────────────────
-- Continues the seed's cadence backward (seed had {128,100,72,44,16}; next is 156).
-- Unique index (user_id, start_date) → ON CONFLICT DO NOTHING. All closed cycles.
WITH offs AS (SELECT unnest(ARRAY[156, 184, 212, 240, 268, 296, 324, 352]) AS off)
INSERT INTO menstrual_cycles (id, user_id, start_date, end_date, period_end_date, length_days, ovulation_date, ovulation_confirmed, is_predicted, tz, created_at, updated_at)
SELECT 'mc_' || replace(gen_random_uuid()::text, '-', ''),
       'usr_demo_cf31025295714ece8d91f5af13afd76d',
       to_char(NOW() - (off || ' days')::interval, 'YYYY-MM-DD'),
       to_char(NOW() - ((off - 27) || ' days')::interval, 'YYYY-MM-DD'),
       to_char(NOW() - ((off - 4) || ' days')::interval, 'YYYY-MM-DD'),
       28,
       to_char(NOW() - ((off - 13) || ' days')::interval, 'YYYY-MM-DD'),
       true, false, 'Europe/Berlin', NOW(), NOW()
FROM offs
ON CONFLICT (user_id, start_date) DO NOTHING;

-- ── Cycle day-logs: offsets 128..364 + phase-clustered symptom links ───────────
-- Mirrors the seed exactly (flow/BBT/mucus/OPK by cycleDay). Unique index
-- (user_id, date) → ON CONFLICT DO NOTHING. Symptom links only attach to rows
-- this run actually inserts (RETURNING), so re-runs add no duplicate links.
WITH gen AS (
  SELECT d, ((128 - d) % 28) + 1 AS cd, to_char(NOW() - (d || ' days')::interval, 'YYYY-MM-DD') AS dstr
  FROM generate_series(128, 364) AS d
),
ins AS (
  INSERT INTO cycle_day_logs (id, user_id, date, flow, basal_body_temp_c, cervical_mucus, ovulation_test, source, tz, sync_version, created_at, updated_at)
  SELECT 'cdl_' || replace(gen_random_uuid()::text, '-', ''),
    'usr_demo_cf31025295714ece8d91f5af13afd76d', g.dstr,
    (CASE g.cd WHEN 1 THEN 'MEDIUM' WHEN 2 THEN 'HEAVY' WHEN 3 THEN 'MEDIUM' WHEN 4 THEN 'LIGHT' WHEN 5 THEN 'SPOTTING' ELSE NULL END)::flow_level,
    round(((CASE WHEN g.cd <= 13 THEN 36.36 ELSE 36.73 END) + (random() - 0.5) * 0.08)::numeric, 2)::float8,
    (CASE WHEN g.cd BETWEEN 1 AND 5 THEN NULL WHEN g.cd BETWEEN 6 AND 9 THEN 'STICKY' WHEN g.cd BETWEEN 10 AND 12 THEN 'CREAMY' WHEN g.cd BETWEEN 13 AND 14 THEN 'EGG_WHITE' WHEN g.cd BETWEEN 15 AND 16 THEN 'WATERY' ELSE 'DRY' END)::cervical_mucus,
    (CASE WHEN g.cd = 13 THEN 'POSITIVE_LH_SURGE' WHEN g.cd IN (11, 12, 14) THEN 'NEGATIVE' ELSE NULL END)::ovulation_test,
    'MANUAL'::measurement_source, 'Europe/Berlin', 0,
    NOW() - (g.d || ' days')::interval, NOW() - (g.d || ' days')::interval
  FROM gen g
  ON CONFLICT (user_id, date) DO NOTHING
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

-- ── Medication intakes: Med A (weekly @ 08:00 Berlin), ~365d ───────────────────
-- The existing demo rows store scheduled_for in UTC at 06:00 (= 08:00 Berlin DST).
-- We mint slots at the Berlin local 08:00 and convert to the stored UTC wall-time
-- with AT TIME ZONE so winter (07:00 UTC) vs summer (06:00 UTC) is honoured.
-- Live partial unique index: (user_id, medication_id, scheduled_for, source)
-- WHERE deleted_at IS NULL → ON CONFLICT on that predicate makes re-runs safe.
-- Compliance ~85-90%: deterministic per-slot pseudo-random skip ~12% of weeks.
-- Never future-dated: WHERE the slot timestamp <= NOW().
WITH slots AS (
  SELECT
    ( (date_trunc('day', NOW() AT TIME ZONE 'Europe/Berlin') - (w * 7 || ' days')::interval + interval '8 hours')
      AT TIME ZONE 'Europe/Berlin' ) AT TIME ZONE 'UTC' AS sched_utc,
    -- deterministic skip decision per week offset (no random(): re-run stable)
    ( (hashtextextended('medA-week-' || w, 0) & 2147483647)::numeric / 2147483647.0 ) AS r
  FROM generate_series(0, 52) AS w   -- 53 weekly slots = w*7 days back ≈ 371 days
)
INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at, sync_version)
SELECT 'cmq_demo_a_' || replace(gen_random_uuid()::text, '-', ''),
       'usr_demo_cf31025295714ece8d91f5af13afd76d',
       'cmq2lzjqh005x01nrys2crzg9',
       s.sched_utc,
       CASE WHEN s.r < 0.88 THEN s.sched_utc + (interval '5 minutes' + (s.r * interval '90 minutes')) ELSE NULL END,
       CASE WHEN s.r < 0.88 THEN false ELSE true END,
       'WEB'::intake_source,
       s.sched_utc, s.sched_utc, 0
FROM slots s
WHERE s.sched_utc <= NOW()
  -- skip slots already covered by the seeded rows (06-06 06:00 + 06-13 06:00)
  AND s.sched_utc < date_trunc('day', NOW()) - interval '1 day'
ON CONFLICT (user_id, medication_id, scheduled_for, source) WHERE deleted_at IS NULL DO NOTHING;

-- ── Medication intakes: Med B (twice daily @ 08:00 + 18:00 Berlin), ~365d ──────
-- One row per due slot per day. Compliance ~85-90%: deterministic per-slot skip
-- ~12% of individual slots. Same TZ + ON CONFLICT + no-future-date guards.
WITH slots AS (
  SELECT
    ( (date_trunc('day', NOW() AT TIME ZONE 'Europe/Berlin') - (dd || ' days')::interval + (hh || ' hours')::interval)
      AT TIME ZONE 'Europe/Berlin' ) AT TIME ZONE 'UTC' AS sched_utc,
    ( (hashtextextended('medB-' || dd || '-' || hh, 0) & 2147483647)::numeric / 2147483647.0 ) AS r
  FROM generate_series(0, 364) AS dd
  CROSS JOIN (VALUES (8), (18)) AS h(hh)
)
INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at, updated_at, sync_version)
SELECT 'cmq_demo_b_' || replace(gen_random_uuid()::text, '-', ''),
       'usr_demo_cf31025295714ece8d91f5af13afd76d',
       'cmq2m0mzk006101nrdpijbij0',
       s.sched_utc,
       CASE WHEN s.r < 0.88 THEN s.sched_utc + (interval '5 minutes' + (s.r * interval '120 minutes')) ELSE NULL END,
       CASE WHEN s.r < 0.88 THEN false ELSE true END,
       'WEB'::intake_source,
       s.sched_utc, s.sched_utc, 0
FROM slots s
WHERE s.sched_utc <= NOW()
  -- skip slots already covered by the seeded rows (today's 06:00 + 16:00 UTC)
  AND s.sched_utc < date_trunc('day', NOW())
ON CONFLICT (user_id, medication_id, scheduled_for, source) WHERE deleted_at IS NULL DO NOTHING;

COMMIT;

-- ── Verification (demo-user-scoped totals after apply) ─────────────────────────
\echo === post-apply totals (demo user) ===
SELECT 'measurements'   AS what, count(*), min(measured_at)::date AS oldest, max(measured_at)::date AS newest FROM measurements   WHERE user_id = :'uid';
SELECT 'mood'           AS what, count(*), min(date) AS oldest, max(date) AS newest FROM mood_entries    WHERE user_id = :'uid';
SELECT 'cycles'         AS what, count(*), min(start_date) AS oldest, max(start_date) AS newest FROM menstrual_cycles WHERE user_id = :'uid';
SELECT 'day_logs'       AS what, count(*), min(date) AS oldest, max(date) AS newest FROM cycle_day_logs  WHERE user_id = :'uid';
SELECT 'symptom_links'  AS what, count(*) FROM cycle_symptom_links l JOIN cycle_day_logs dl ON l.day_log_id = dl.id WHERE dl.user_id = :'uid';
SELECT 'intake_medA'    AS what, count(*), count(*) FILTER (WHERE taken_at IS NOT NULL) AS taken, count(*) FILTER (WHERE skipped) AS skipped FROM medication_intake_events WHERE user_id = 'usr_demo_cf31025295714ece8d91f5af13afd76d' AND medication_id = 'cmq2lzjqh005x01nrys2crzg9';
SELECT 'intake_medB'    AS what, count(*), count(*) FILTER (WHERE taken_at IS NOT NULL) AS taken, count(*) FILTER (WHERE skipped) AS skipped FROM medication_intake_events WHERE user_id = 'usr_demo_cf31025295714ece8d91f5af13afd76d' AND medication_id = 'cmq2m0mzk006101nrdpijbij0';
