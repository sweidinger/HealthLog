-- HealthLog demo computed-wellness-score seeder for apps01 (1 year).
--
-- WHAT THIS DOES
--   Seeds the three PERSISTED nightly wellness scores for the demo account so
--   all of the dashboard's "Deine Gesundheitswerte" rings render with a full
--   year of history. These three are normally written by the nightly score
--   crons (src/lib/jobs/{recovery,stress,strain}-score.ts) as COMPUTED
--   Measurement rows; the demo never had them computed, so only the two
--   compute-on-read composites (READINESS + SLEEP_SCORE — derived live from the
--   demo's RHR/HRV/sleep/mood, NOT stored) were showing.
--
--     channel         type            external_id          unit     value
--     Recovery        RECOVERY_SCORE  recovery:YYYY-MM-DD   score    0..100 (55-90)
--     Strain          STRAIN_SCORE    strain:YYYY-MM-DD     score    0..100 (20-75)
--     Stress          STRESS_SCORE    stress:YYYY-MM-DD     score    0..100 (25-65)
--
--   READINESS and SLEEP_SCORE are NOT seeded here: neither exists in the
--   measurement_type enum (verified live) — both are recomputed on read from
--   the underlying signals the demo already carries, so they already render and
--   a stored row would be ignored. Seeding them would be dead data.
--
--   Row shape mirrors src/lib/insights/score-row.ts::upsertScoreRow exactly:
--   source = COMPUTED, unit = 'score', measured_at = noon UTC on the scored day,
--   external_id = '<prefix>:YYYY-MM-DD', sleep_stage / device_type /
--   external_source_version / deleted_at all NULL.
--
--   Coverage: one row per (channel, UTC day) for the last 365 days (offsets
--   1..365 — offset 0 is "today", which the nightly cron scores as the PREVIOUS
--   day, so the freshest persisted day is yesterday; this matches the job and
--   keeps every row strictly measured_at <= NOW()). 365 days x 3 channels =
--   1,095 rows on a clean apply.
--
-- DETERMINISM
--   Values + ids are hash-derived from the day stamp (hashtextextended /
--   md5 — NO random()), so a re-run is byte-stable. Idempotent re-runs are
--   additionally guarded by ON CONFLICT DO NOTHING on the live unique index
--   (user_id, type, source, external_id) — the exact key the cron upserts on.
--
-- SCOPE + SAFETY
--   - Demo-user-scoped: EVERY statement hardcodes the demo user id.
--   - Idempotent: ON CONFLICT DO NOTHING; re-running adds nothing.
--   - No DDL (no CREATE/ALTER/DROP/TRUNCATE), no other-user writes, no
--     table-wide DELETE/UPDATE, no future-dated rows (measured_at <= NOW()).
--
-- Run:  ssh apps-01 'docker exec -i <db-container> psql -U healthlog -d healthlog' < scripts/seed-demo-scores-1y.sql

\set uid 'usr_demo_cf31025295714ece8d91f5af13afd76d'

BEGIN;

-- Refuse to run if the demo user does not exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = 'usr_demo_cf31025295714ece8d91f5af13afd76d') THEN
    RAISE EXCEPTION 'seed-demo-scores-1y: demo user not found';
  END IF;
END $$;

-- ── The three persisted score channels, one row per (channel, day) ─────────────
-- offsets 1..365 (the scored day is the day that just ended; offset 0 = today is
-- never persisted by the cron). day_key is the UTC calendar day; measured_at is
-- noon UTC on it, mirroring scoreMeasuredAt(). Deterministic values:
--   - week phase  : a gentle 7-day sinusoid keyed to the day-of-year (weekly
--                   rhythm — lighter mid-week, heavier toward the weekend).
--   - noise       : per-(channel,day) hash in [0,1), no random().
--   - recovery    : 55..90, dips after a "hard" (high-strain) day.
--   - strain      : 20..75, weekend / mid-week training spikes (~25% of days).
--   - stress      : 25..65, inversely coupled to recovery (recovery up → stress
--                   down) so the two rings tell a coherent story.
WITH days AS (
  SELECT
    d,
    (NOW() AT TIME ZONE 'UTC')::date - d AS day_key
  FROM generate_series(1, 365) AS d
),
calc AS (
  SELECT
    d,
    day_key,
    (day_key + 12)::timestamp AS measured_at,  -- noon UTC on the scored day
    -- weekly rhythm in [-1, 1] from ISO day-of-week (Mon=1..Sun=7)
    sin(2 * pi() * (extract(isodow FROM day_key)::numeric - 1) / 7.0) AS week_phase,
    -- deterministic per-day "is this a training day" flag (~25%)
    ( (hashtextextended('score-train-' || day_key::text, 0) & 2147483647)::numeric / 2147483647.0 ) AS train_r,
    -- independent deterministic noise streams per channel, all in [0,1)
    ( (hashtextextended('score-rec-'    || day_key::text, 0) & 2147483647)::numeric / 2147483647.0 ) AS rec_r,
    ( (hashtextextended('score-str-'    || day_key::text, 0) & 2147483647)::numeric / 2147483647.0 ) AS str_r,
    ( (hashtextextended('score-stress-' || day_key::text, 0) & 2147483647)::numeric / 2147483647.0 ) AS stress_r
  FROM days
),
vals AS (
  SELECT
    d, day_key, measured_at, train_r,
    -- STRAIN 20..75: base + weekly rhythm + a spike on training days.
    LEAST(75, GREATEST(20, round(
      40 + week_phase * 8
         + (CASE WHEN train_r < 0.25 THEN 22 ELSE 0 END)
         + (str_r - 0.5) * 14
    )))::int AS strain,
    -- RECOVERY 55..90: base + weekly rhythm, suppressed the day after a hard day.
    LEAST(90, GREATEST(55, round(
      74 + week_phase * 6
         - (CASE WHEN train_r < 0.25 THEN 7 ELSE 0 END)
         + (rec_r - 0.5) * 16
    )))::int AS recovery
  FROM calc
),
final AS (
  SELECT
    v.d, v.day_key, v.measured_at, v.strain, v.recovery,
    -- STRESS 25..65: inverse to recovery (high recovery → low stress) + noise.
    LEAST(65, GREATEST(25, round(
      90 - v.recovery * 0.5
         + (c.stress_r - 0.5) * 14
    )))::int AS stress
  FROM vals v JOIN calc c USING (d)
),
rows AS (
  SELECT day_key, measured_at, type, ext_prefix, value FROM final,
  LATERAL (VALUES
    ('RECOVERY_SCORE', 'recovery:', recovery),
    ('STRAIN_SCORE',   'strain:',   strain),
    ('STRESS_SCORE',   'stress:',   stress)
  ) AS ch(type, ext_prefix, value)
)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  -- deterministic id from the per-row external_id → byte-stable re-runs.
  'm_score_' || md5(ext_prefix || to_char(day_key, 'YYYY-MM-DD')),
  'usr_demo_cf31025295714ece8d91f5af13afd76d',
  type::measurement_type,
  value::float8,
  'score',
  'COMPUTED'::measurement_source,
  measured_at,
  ext_prefix || to_char(day_key, 'YYYY-MM-DD'),
  measured_at,
  measured_at
FROM rows
WHERE measured_at <= NOW()
ON CONFLICT (user_id, type, source, external_id) DO NOTHING;

COMMIT;

-- ── Verification (demo-user-scoped, all five score channels) ───────────────────
\echo === post-apply score coverage (demo user) ===
SELECT type, count(*) AS rows, min(measured_at)::date AS oldest, max(measured_at)::date AS newest
FROM measurements
WHERE user_id = :'uid'
  AND type IN ('RECOVERY_SCORE', 'STRAIN_SCORE', 'STRESS_SCORE')
GROUP BY type
ORDER BY type;
\echo (READINESS + SLEEP_SCORE are compute-on-read composites — not stored, render from underlying signals.)
