-- v1.29.x — backfill non-canonical Strava `Workout.sport_type` values.
--
-- Root cause (the same class the 0247 WHOOP migration fixed): Strava was the
-- second workout integration that never normalised its sport to HealthLog's
-- canonical `WorkoutSportType` enum (see `workoutSportTypeEnum` in
-- src/lib/validations/workout.ts). `mapActivity()` in
-- src/lib/strava/client.ts wrote Strava's raw PascalCase `sport_type` (or
-- the legacy `type`, e.g. "Run", "Ride", "VirtualRide", "TrailRun") — or the
-- literal fallback "workout" when neither field was present — straight into
-- `Workout.sport_type`. Existing Strava rows therefore carry values the
-- `/insights/workouts` list can't map to an icon/label, AND the read-time
-- canonical picker in src/lib/sources/pick-canonical-workout.ts treats any
-- two non-canonical ("generic") rows as sport-compatible — a same-source
-- brick session (a Strava "Ride" ending 15:00 immediately followed by a
-- Strava "Run" starting 15:03) could cluster into one and silently drop a
-- leg. `mapStravaSportType()` (src/lib/strava/sport-map.ts) fixes the write
-- path going forward; this migration re-derives every EXISTING Strava
-- `Workout` row from the same table so historical data and the live mapper
-- never drift apart.
--
-- The WHEN arms below were generated FROM `STRAVA_SPORT_TABLE` in
-- src/lib/strava/sport-map.ts (one JS-side script run against that exact
-- table, not hand-transcribed). The match expression lower-cases the stored
-- column and strips every character outside `[a-zA-Z0-9]`, mirroring
-- `normaliseStravaSportKey()` in sport-map.ts exactly, so "TrailRun",
-- "trailrun", and any stray-separator variant all resolve to the same key —
-- and so the pre-fix literal fallback "workout" resolves to the same row as
-- Strava's own "Workout" catch-all.
--
-- Anything neither arm recognises falls to `ELSE 'other'` — same fallback
-- `mapStravaSportType()` uses, never leaves a row on a raw Strava label.
--
-- Idempotent: the WHERE clause excludes rows whose `sport_type` is ALREADY
-- one of the 20 canonical values, so a re-run touches zero rows once the
-- first run has completed. Safe to re-run after a partial failure.
UPDATE "workouts"
SET "sport_type" = CASE
  lower(regexp_replace(trim("sport_type"), '[^a-zA-Z0-9]+', '', 'g'))
    WHEN 'alpineski' THEN 'other'
    WHEN 'backcountryski' THEN 'other'
    WHEN 'badminton' THEN 'tennis'
    WHEN 'basketball' THEN 'basketball'
    WHEN 'canoeing' THEN 'rowing'
    WHEN 'cricket' THEN 'other'
    WHEN 'crossfit' THEN 'crossTraining'
    WHEN 'dance' THEN 'dance'
    WHEN 'ebikeride' THEN 'cycling'
    WHEN 'elliptical' THEN 'elliptical'
    WHEN 'emountainbikeride' THEN 'cycling'
    WHEN 'golf' THEN 'golf'
    WHEN 'gravelride' THEN 'cycling'
    WHEN 'handcycle' THEN 'cycling'
    WHEN 'highintensityintervaltraining' THEN 'hiit'
    WHEN 'hike' THEN 'hiking'
    WHEN 'iceskate' THEN 'other'
    WHEN 'inlineskate' THEN 'other'
    WHEN 'kayaking' THEN 'rowing'
    WHEN 'kitesurf' THEN 'other'
    WHEN 'mountainbikeride' THEN 'cycling'
    WHEN 'nordicski' THEN 'other'
    WHEN 'padel' THEN 'tennis'
    WHEN 'physicaltherapy' THEN 'mindAndBody'
    WHEN 'pickleball' THEN 'tennis'
    WHEN 'pilates' THEN 'mindAndBody'
    WHEN 'racquetball' THEN 'tennis'
    WHEN 'ride' THEN 'cycling'
    WHEN 'rockclimbing' THEN 'crossTraining'
    WHEN 'rollerski' THEN 'other'
    WHEN 'rowing' THEN 'rowing'
    WHEN 'run' THEN 'running'
    WHEN 'sail' THEN 'other'
    WHEN 'skateboard' THEN 'other'
    WHEN 'snowboard' THEN 'other'
    WHEN 'snowshoe' THEN 'hiking'
    WHEN 'soccer' THEN 'soccer'
    WHEN 'squash' THEN 'tennis'
    WHEN 'stairstepper' THEN 'stairClimber'
    WHEN 'standuppaddling' THEN 'rowing'
    WHEN 'surfing' THEN 'other'
    WHEN 'swim' THEN 'swimming'
    WHEN 'tabletennis' THEN 'tennis'
    WHEN 'tennis' THEN 'tennis'
    WHEN 'trailrun' THEN 'running'
    WHEN 'velomobile' THEN 'cycling'
    WHEN 'virtualride' THEN 'cycling'
    WHEN 'virtualrow' THEN 'rowing'
    WHEN 'virtualrun' THEN 'running'
    WHEN 'volleyball' THEN 'other'
    WHEN 'walk' THEN 'walking'
    WHEN 'weighttraining' THEN 'strength'
    WHEN 'wheelchair' THEN 'other'
    WHEN 'windsurf' THEN 'other'
    WHEN 'workout' THEN 'other'
    WHEN 'yoga' THEN 'yoga'
  ELSE 'other'
END
WHERE "source" = 'STRAVA'
  AND "sport_type" NOT IN (
    'walking', 'running', 'cycling', 'hiking', 'swimming', 'rowing',
    'elliptical', 'stairClimber', 'yoga', 'mindAndBody', 'strength', 'hiit',
    'dance', 'golf', 'tennis', 'basketball', 'soccer', 'crossTraining',
    'mixedCardio', 'other'
  );
