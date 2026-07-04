# Google Health field → Measurement mapping

Single source of truth for the Google Health API v4 data-type → HealthLog
`Measurement` mapping. Keep this in sync with the per-type mappers in `client.ts`.
Every row ingests server-side with `source = GOOGLE_HEALTH` and
`externalId = <anchor>:<fieldTag>` (the anchor is the data point's sample time for
spot readings, its civil date for daily summaries, or — for INTERVAL types
(steps/distance/energy/floors, sleep, exercise) — its `interval.civil_start_time`
anchored at UTC-midday, falling back to `interval.start_time` only when the civil
date is absent; the field-tag disambiguates the metric).

Google Health is a **separate, coexisting provider** from the classic Fitbit
integration (`src/lib/fitbit/*`, `source = FITBIT`). They never share a token,
connection row, source enum, or cookie.

## Time anchor by grain

Google Health exposes three time-anchor shapes. The incremental `filter` and the
read-time `measuredAt`/externalId resolution must target the right one or the
incremental sync stalls (a `sample_time` filter 400s/empties for an INTERVAL type):

- **sample** — spot reading; anchor `{filter}.sample_time.physical_time`.
- **date** — daily-summary metric (SpO2, HRV, RHR, respiratory rate, VO2 max);
  anchor `{filter}.date` (a civil date / `{year,month,day}`).
- **interval** — INTERVAL type (steps/distance/energy/floors daily totals, plus
  sleep + exercise sessions); the incremental `filter` targets
  `{filter}.interval.start_time`, but the read-time `measuredAt`/day-key derive
  from `{filter}.interval.civil_start_time` anchored at UTC-midday, so a daily
  total keys on the civil day (aligning with the Apple/Fitbit `stats:` contract);
  the physical `start_time` is the fallback only when civil is absent.

Transport docs: `developers.google.com/health` (v4). The per-type value-field
JSON is **NOT fully published** — the mappers read a small set of candidate value
paths defensively (`firstNumber` walks each shape and takes the first
finite-positive hit). **Re-verify against a live test account at build** and
tighten the extractors.

## Read method

Every launch data type supports `dataPoints.list` (`readMethod: "list"`, the only
method the transport uses). The rollup-only types (`total-calories`,
`calories-in-heart-rate-zone`, which have no `:list`) are deliberately **not** in
the launch set: active energy already covers the active-calories slot, and
`total-calories` folds in BMR and needs a modelling decision before it lands as a
metric. Adding either later means adding a `:dailyRollUp` reader together with it.

## Casing gotcha

The data-type id is **kebab-case in the request path** (`body-fat`) and
**snake_case in the `filter` predicate** (`body_fat`). `GOOGLE_HEALTH_DATA_TYPES`
pins both forms per type so a fetcher can never encode the wrong one.

## Health-metrics bundle

Scope: `googlehealth.health_metrics_and_measurements.readonly`. Identifiers
verified against the 2026 contract (API-RESEARCH §3/§4).

| Data type (path / filter)                               | MeasurementType          | Unit        | fieldTag    | Grain  | Note                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------ | ----------- | ----------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weight` / `weight`                                     | `WEIGHT`                 | kg          | `weight`    | sample | Picker ranks a real Withings scale above Google Health.                                                                                                              |
| `body-fat` / `body_fat`                                 | `BODY_FAT`               | %           | `body_fat`  | sample |                                                                                                                                                                      |
| `oxygen-saturation` / `oxygen_saturation`               | `OXYGEN_SATURATION`      | %           | `spo2`      | daily  | Already 0–100.                                                                                                                                                       |
| `heart-rate-variability` / `heart_rate_variability`     | `HEART_RATE_VARIABILITY` | ms          | `hrv`       | daily  | **Decision:** SDNN slot (Apple-comparable), NOT `HRV_RMSSD`. Google reports an RMSSD-style nightly HRV — confirm the estimator at build and reconsider if warranted. |
| `daily-resting-heart-rate` / `daily_resting_heart_rate` | `RESTING_HEART_RATE`     | bpm         | `rhr`       | daily  |                                                                                                                                                                      |
| `respiratory-rate` / `respiratory_rate`                 | `RESPIRATORY_RATE`       | breaths/min | `resp_rate` | daily  | Identifier appears in spec prose; confirm `:list` support at build (API-RESEARCH OPEN §4).                                                                           |
| `heart-rate` / `heart_rate`                             | `PULSE`                  | bpm         | `hr`        | sample | Intraday spot HR.                                                                                                                                                    |
| `height` / `height`                                     | `User.heightCm`          | cm          | —           | sample | Profile seed — written to `User.heightCm` ONLY when null; never minted as a Measurement (WHOOP `mapBody` pattern). m→cm when reported in metres.                     |

Skin temperature (`daily-sleep-temperature-derivations`) is intentionally **not**
in the launch set — see **Deferred** below.

Every value passes a finite + strictly-positive guard (the launch metrics are all
positive — a zero/NaN is a garbage/empty reading and is dropped).

## Deferred (Google Health Q3-2026 roadmap — slots exist, NOT in launch set)

`blood-glucose` → `BLOOD_GLUCOSE`, `blood-pressure` → `BLOOD_PRESSURE_SYS`+`_DIA`,
`basal-body-temperature` → `BODY_TEMPERATURE`, `electrocardiogram` (ECG) and
`irregular-rhythm-notification`. Skin-temperature deviation
(`daily-sleep-temperature-derivations`) also sits here: Google reports a signed
nightly delta from baseline, not an absolute reading, so it needs a signed-delta
model before it can land — mapping it into `WRIST_TEMPERATURE` would store a delta
as an absolute temperature. ECG/IRN light up when Google ships the data types and
a reader is added together with its Restricted scopes.

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
