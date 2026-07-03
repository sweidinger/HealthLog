# Google Health field → Measurement mapping

Single source of truth for the Google Health API v4 data-type → HealthLog
`Measurement` mapping. Keep this in sync with `GOOGLE_HEALTH_FIELD_MAP` and the
per-type mappers in `client.ts`. Every row ingests server-side with
`source = GOOGLE_HEALTH` and `externalId = <anchor>:<fieldTag>` (the anchor is the
data point's sample time for spot readings, its civil date for daily summaries,
or its `interval.start_time` for INTERVAL types — steps/distance/calories/floors,
sleep, exercise; the field-tag disambiguates the metric).

Google Health is a **separate, coexisting provider** from the classic Fitbit
integration (`src/lib/fitbit/*`, `source = FITBIT`). They never share a token,
connection row, source enum, or cookie.

## Time anchor by grain

Google Health exposes three time-anchor shapes. The incremental `filter` and the
read-time `measuredAt`/externalId resolution must target the right one or the
incremental sync stalls (a `sample_time` filter 400s/empties for an INTERVAL type):

- **sample** — spot reading; anchor `{filter}.sample_time.physical_time`.
- **date** — daily-summary metric (SpO2, HRV, RHR, respiratory rate, wrist temp,
  VO2 max); anchor `{filter}.date` (a civil date / `{year,month,day}`).
- **interval** — INTERVAL type (steps/distance/calories/floors daily totals, plus
  sleep + exercise sessions); anchor `{filter}.interval.start_time` (a physical
  instant) with `{filter}.interval.civil_start_time` as the civil fallback.

Transport docs: `developers.google.com/health` (v4). The per-type value-field
JSON is **NOT fully published** — the mappers read a small set of candidate value
paths defensively (`firstNumber` walks each shape and takes the first
finite-positive hit). **Re-verify against a live test account at build** and
tighten the extractors.

## Read method

Most data types support `dataPoints.list` (`readMethod: "list"`, the default).
Two types — `total-calories` and `calories-in-heart-rate-zone` — have **no
`:list`** and are read via `dataPoints:dailyRollUp` (`readMethod: "dailyRollUp"`,
one civil day per request). They are defined in `GOOGLE_HEALTH_DATA_TYPES` so the
read layer routes them correctly, but are **not yet wired to a Measurement
mapper** (active energy already covers the active-calories slot; `total-calories`
folds in BMR and needs a modelling decision before it lands as a metric).

## Casing gotcha

The data-type id is **kebab-case in the request path** (`body-fat`) and
**snake_case in the `filter` predicate** (`body_fat`). `GOOGLE_HEALTH_DATA_TYPES`
pins both forms per type so a fetcher can never encode the wrong one.

## Health-metrics bundle

Scope: `googlehealth.health_metrics_and_measurements.readonly`. Identifiers
verified against the 2026 contract (API-RESEARCH §3/§4).

| Data type (path / filter)                                                     | MeasurementType          | Unit        | fieldTag     | Grain  | Note                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------ | ----------- | ------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weight` / `weight`                                                           | `WEIGHT`                 | kg          | `weight`     | sample | Picker ranks a real Withings scale above Google Health.                                                                                                              |
| `body-fat` / `body_fat`                                                       | `BODY_FAT`               | %           | `body_fat`   | sample |                                                                                                                                                                      |
| `oxygen-saturation` / `oxygen_saturation`                                     | `OXYGEN_SATURATION`      | %           | `spo2`       | daily  | Already 0–100.                                                                                                                                                       |
| `heart-rate-variability` / `heart_rate_variability`                           | `HEART_RATE_VARIABILITY` | ms          | `hrv`        | daily  | **Decision:** SDNN slot (Apple-comparable), NOT `HRV_RMSSD`. Google reports an RMSSD-style nightly HRV — confirm the estimator at build and reconsider if warranted. |
| `daily-resting-heart-rate` / `daily_resting_heart_rate`                       | `RESTING_HEART_RATE`     | bpm         | `rhr`        | daily  |                                                                                                                                                                      |
| `respiratory-rate` / `respiratory_rate`                                       | `RESPIRATORY_RATE`       | breaths/min | `resp_rate`  | daily  | Identifier appears in spec prose; confirm `:list` support at build (API-RESEARCH OPEN §4).                                                                           |
| `heart-rate` / `heart_rate`                                                   | `PULSE`                  | bpm         | `hr`         | sample | Intraday spot HR.                                                                                                                                                    |
| `daily-sleep-temperature-derivations` / `daily_sleep_temperature_derivations` | `WRIST_TEMPERATURE`      | celsius     | `wrist_temp` | daily  | Closest semantic slot to Apple sleeping-wrist-temp. Confirm absolute-vs-baseline at build; the positive guard rejects a baseline-delta reading.                      |
| `height` / `height`                                                           | `User.heightCm`          | cm          | —            | sample | Profile seed — written to `User.heightCm` ONLY when null; never minted as a Measurement (WHOOP `mapBody` pattern). m→cm when reported in metres.                     |

Every value passes a finite + strictly-positive guard (the launch metrics are all
positive — a zero/NaN is a garbage/empty reading and is dropped).

## Deferred (Google Health Q3-2026 roadmap — slots exist, NOT in launch set)

`blood-glucose` → `BLOOD_GLUCOSE`, `blood-pressure` → `BLOOD_PRESSURE_SYS`+`_DIA`,
`basal-body-temperature` → `BODY_TEMPERATURE`, `electrocardiogram` (ECG) and
`irregular-rhythm-notification` (gated behind the experimental ECG/IRN scopes).
These light up when Google ships the data types + the operator opts in.

## Activity bundle — daily cumulative

Scope: `googlehealth.activity_and_fitness.readonly`. Each is a per-day summary
(one value per calendar day). The externalId carries the `stats:` daily-total
prefix — `stats:<fieldTag>:<YYYY-MM-DD>` — so a re-fetched day **overwrites** in
place rather than minting a duplicate, matching the Apple-Health
`stats:<HK>:<YYYY-MM-DD>` daily-total overwrite contract. The running totals
(steps/distance/floors/active-energy) **preserve a 0** (a rest day is real data,
not a gap); VO2 max stays strictly positive (daily latest-wins).

| Data type (path / filter)                       | MeasurementType            | Unit        | fieldTag        | Note                                                                |
| ----------------------------------------------- | -------------------------- | ----------- | --------------- | ------------------------------------------------------------------- |
| `steps` / `steps`                               | `ACTIVITY_STEPS`           | steps       | `steps`         | daily total; 0 valid                                                |
| `distance` / `distance`                         | `WALKING_RUNNING_DISTANCE` | m           | `distance`      | metres (km → m when reported in km)                                 |
| `active-energy-burned` / `active_energy_burned` | `ACTIVE_ENERGY_BURNED`     | kcal        | `active_energy` | **ACTIVE portion only** — NOT `total-calories` (which folds in BMR) |
| `floors` / `floors`                             | `FLIGHTS_CLIMBED`          | flights     | `floors`        | daily total; 0 valid                                                |
| `vo2-max` / `vo2_max`                           | `VO2_MAX`                  | mL/(kg·min) | `vo2_max`       | daily latest-wins; strictly positive                                |

## Roll-up-only types (no `:list`)

Scope: `googlehealth.activity_and_fitness.readonly`. Read via `:dailyRollUp`; not
yet mapped to a MeasurementType (see **Read method** above).

| Data type (path / filter)                                     | Status                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `total-calories` / `total_calories`                           | roll-up-only; folds in BMR; modelling decision pending  |
| `calories-in-heart-rate-zone` / `calories_in_heart_rate_zone` | roll-up-only; per-zone breakdown; no HealthLog slot yet |

## Sleep bundle

Scope: `googlehealth.sleep.readonly`. A sleep session carries per-stage segments
(stage label + start + end). HealthLog stores one `SLEEP_DURATION` row per stage
SEGMENT, `measuredAt = that segment's END instant`, harmonised onto the shared
`SleepStage` enum the night-total + hypnogram readers consume. externalId =
`<session-anchor>:sleep_<stage>:<i>` (session end ISO instant + indexed segment),
so a re-scored night overwrites in place. Stage map: `light → CORE` ("light" ↔
Apple "core" shallow-NREM band), `deep → DEEP`, `rem → REM`,
`awake`/`wake`/`restless → AWAKE`, `in_bed → IN_BED`, classic `asleep → ASLEEP`.
Unknown stage labels are skipped, not mis-bucketed.

## Exercise bundle — Workouts

Scope: `googlehealth.activity_and_fitness.readonly`. Each exercise session → one
`Workout` row (NOT a Measurement), keyed `(userId, source: "GOOGLE_HEALTH",
externalId)` where externalId is the session id (or `exercise:<startISO>` when
absent). Fields: sportType (Google activity type → canonical `WorkoutSportType`,
`other` fallback), startedAt/endedAt, durationSec, totalEnergyKcal (active session
energy), totalDistanceM, avg/max/min HR (optional). A Google Health run and the
same run via Apple Health / WHOOP stay distinct rows; the read-time
`pickCanonicalWorkoutRows` picker collapses the cross-source twin per the user's
source ladder.

## Idempotency

`(userId, type, source: "GOOGLE_HEALTH", externalId)` unique. Spot/daily metric
rows: `externalId = <anchor>:<fieldTag>`. Daily cumulative activity rows:
`externalId = stats:<fieldTag>:<YYYY-MM-DD>` (Apple-Health overwrite shape).
Workouts: `(userId, source: "GOOGLE_HEALTH", externalId)` on the `Workout` table.
A re-fetch of the same window (daily summaries re-roll after the fact, so the
incremental overlap is 24 h) overwrites in place.
