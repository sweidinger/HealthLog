# Google Health field → Measurement mapping

Single source of truth for the Google Health API v4 data-type → HealthLog
`Measurement` mapping. Keep this in sync with the per-type mappers in `client.ts`.
Every row ingests server-side with `source = GOOGLE_HEALTH` and
`externalId = <anchor>:<fieldTag>` (the anchor is the data point's sample time for
spot readings or its civil date for daily summaries; the field-tag disambiguates
the metric). The cumulative daily totals use the `stats:<fieldTag>:<YYYY-MM-DD>`
overwrite shape instead.

Google Health is a **separate, coexisting provider** from the classic Fitbit
integration (`src/lib/fitbit/*`, `source = FITBIT`). They never share a token,
connection row, source enum, or cookie.

## The three encodings (casing)

Each data type has THREE on-the-wire encodings, all pinned in
`GOOGLE_HEALTH_DATA_TYPES` so a fetcher can never mix them up:

- **request path** — kebab-case (`body-fat`, `daily-resting-heart-rate`).
- **`filter` parameter** — snake_case (`body_fat.sample_time.physical_time`)
  for sample / interval / session / sleep shapes. **Daily-summary `.date`
  filters are the documented self-contradiction**: the data-types index's
  "filter parameter" column says snake_case (`daily_heart_rate_variability`),
  but the `dataPoints.list` reference's only worked daily example is
  `dailyHeartRateVariability.date < "2024-08-15"` — the camelCase payload key.
  Live, the snake form returned HTTP 200 with zero rows on accounts whose
  companion app visibly holds daily HRV/RHR. The client sends the camelCase
  worked-example form first and falls back to snake_case once if the first
  page 400s; the accepted style is annotated
  (`googleHealth.dateFilter.style`) and surfaced by the structure probe as
  `requestShape`.
- **response payload** — camelCase. The `DataPoint` value is a union keyed by
  the camelCase type name (`bodyFat`, `dailyRestingHeartRate`,
  `activeEnergyBurned`, …) with camelCase nested objects
  (`sampleTime.physicalTime`, `interval.startTime`, `civilStartTime.date`).

proto3 int64 fields arrive as JSON **strings** (`"12345"`): `steps.countSum`,
`heartRate.beatsPerMinute`, `dailyRestingHeartRate.beatsPerMinute`,
`height.heightMillimeters`, `distance.millimetersSum`, `floors.countSum`,
`exercise.metricsSummary.averageHeartRateBeatsPerMinute`, the sleep summary
minutes. Every numeric extractor coerces numeric strings before the finite
check. (`dailyRespiratoryRate.breathsPerMinute` is a plain JSON number.)

## Read method

Two read methods are in use — NOT every type supports `dataPoints.list`:

- **`dataPoints.list`** (GET, `nextPageToken` pagination) — spot samples
  (weight, body-fat, heart-rate, height), daily summaries
  (daily-oxygen-saturation, daily-heart-rate-variability,
  daily-resting-heart-rate, daily-respiratory-rate, daily-vo2-max), and the
  session types (sleep, exercise; pageSize default & max **25**).
- **`dataPoints:dailyRollUp`** (POST, `windowSizeDays: 1`) — the cumulative
  activity totals (steps, distance, active-energy-burned, floors). Their list
  surface returns minute-grain observation buckets (≈1440/day), NOT daily
  totals — and **floors has no list method at all**. The request range is a
  pair of CivilDateTime bounds (`{date:{year,month,day}, time:{hours,minutes,
seconds,nanos}}`), user-local; per the documented example, the `end` bound
  is the LAST covered civil day at 23:59:59 — not the next day's midnight.
  Max **90 days** per request for these types (14 days only for
  heart-rate / total-calories / active-minutes / calories-in-heart-rate-zone);
  the client chunks longer ranges (`buildDailyRollUpBody`), falls back once to
  14-day chunks if the first request 400s, and pins the full-sync horizon
  (`GOOGLE_HEALTH_ROLLUP_BACKFILL_DAYS`).

Legal incremental `filter` fields are per-shape — anything else is an HTTP 400
`INVALID_ARGUMENT`:

| Shape         | Filter field                                                          | Bound format                   |
| ------------- | --------------------------------------------------------------------- | ------------------------------ |
| Sample        | `{snake_type}.sample_time.physical_time`                              | RFC-3339                       |
| Daily summary | `{camelType}.date` (worked example), snake fallback on first-page 400 | `YYYY-MM-DD`                   |
| Sleep         | `sleep.interval.end_time` (the ONLY legal time field)                 | RFC-3339                       |
| Session       | `{snake_type}.interval.civil_start_time` (the ONLY legal one)         | offset-less civil ISO (no `Z`) |

The exercise civil bound is derived from the watermark in the USER'S zone.

## Health-metrics bundle

Scope: `googlehealth.health_metrics_and_measurements.readonly`.

| Data type (path)               | Payload value read                                                  | MeasurementType          | Unit        | fieldTag    | Grain  | Note                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------ | ----------- | ----------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `weight`                       | `weight.weightGrams` ÷ 1000                                         | `WEIGHT`                 | kg          | `weight`    | sample | Grams on the wire. Picker ranks a real Withings scale above Google Health.                                                                                                       |
| `body-fat`                     | `bodyFat.percentage`                                                | `BODY_FAT`               | %           | `body_fat`  | sample | Union key is camelCase `bodyFat`.                                                                                                                                                |
| `daily-oxygen-saturation`      | `dailyOxygenSaturation.averagePercentage`                           | `OXYGEN_SATURATION`      | %           | `spo2`      | daily  | The bare `oxygen-saturation` type is per-SAMPLE and rejects a `.date` filter.                                                                                                    |
| `daily-heart-rate-variability` | `dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds` | `HEART_RATE_VARIABILITY` | ms          | `hrv`       | daily  | **Decision:** SDNN slot (Apple-comparable), NOT `HRV_RMSSD`. The daily field is an unlabelled "average HRV ms" — re-confirm estimator live.                                      |
| `daily-resting-heart-rate`     | `dailyRestingHeartRate.beatsPerMinute` (int64 string)               | `RESTING_HEART_RATE`     | bpm         | `rhr`       | daily  |                                                                                                                                                                                  |
| `daily-respiratory-rate`       | `dailyRespiratoryRate.breathsPerMinute` (number)                    | `RESPIRATORY_RATE`       | breaths/min | `resp_rate` | daily  | `respiratory-rate` does NOT exist in the catalogue. Schema is `{date, breathsPerMinute}` — the earlier `dailyRespiratoryRateBpm` leaf never existed.                             |
| `heart-rate`                   | `heartRate.beatsPerMinute` (int64 string)                           | `PULSE`                  | bpm         | `hr`        | sample | Intraday spot HR; per-minute volume — consider the 14-day-max rollup if PULSE should stay coarse.                                                                                |
| `height`                       | `height.heightMillimeters` (int64 string) ÷ 10                      | `User.heightCm`          | cm          | —           | sample | Profile seed — written ONLY when null; never a Measurement. List order is DESCENDING → the seed picks max(sampleTime) explicitly. The earlier `heightMeters` leaf never existed. |

Daily-summary `date` fields are `{year,month,day}` objects, anchored at
UTC-midday so a timezone shift can't roll the civil day. Every value passes a
finite + strictly-positive guard (the metric-bundle readings are all positive —
a zero/NaN is a garbage/empty reading and is dropped).

Skin temperature (`daily-sleep-temperature-derivations`) is intentionally **not**
in the launch set — see **Deferred** below.

## Deferred (Google Health Q3-2026 roadmap — slots exist, NOT in launch set)

`blood-glucose` → `BLOOD_GLUCOSE`, `blood-pressure` → `BLOOD_PRESSURE_SYS`+`_DIA`,
`basal-body-temperature` → `BODY_TEMPERATURE`, `electrocardiogram` (ECG) and
`irregular-rhythm-notification`. Skin-temperature deviation
(`daily-sleep-temperature-derivations`) also sits here: Google reports a signed
nightly delta from baseline, not an absolute reading, so it needs a signed-delta
model before it can land — mapping it into `WRIST_TEMPERATURE` would store a delta
as an absolute temperature. ECG/IRN light up when Google ships the data types and
a reader is added together with its Restricted scopes.

## Activity bundle — daily cumulative (dailyRollUp)

Scope: `googlehealth.activity_and_fitness.readonly`. The four running totals
read through `POST :dailyRollUp` with `windowSizeDays: 1`; each aggregate window
carries `civilStartTime`/`civilEndTime` (CivilDateTime objects —
`{date:{year,month,day}, time:{…}}`) and a union keyed by the camelCase type
name with the `*Sum` rollup fields. The day key comes from
`civilStartTime.date`, anchored at UTC-midday. The externalId carries the
`stats:` daily-total prefix — `stats:<fieldTag>:<YYYY-MM-DD>` — so a re-fetched
day **overwrites** in place, matching the Apple-Health
`stats:<HK>:<YYYY-MM-DD>` overwrite contract. The running totals **preserve a
0** (a rest day is real data, not a gap).

| Data type (path)       | Rollup value read                              | MeasurementType            | Unit    | fieldTag        | Note                                                                |
| ---------------------- | ---------------------------------------------- | -------------------------- | ------- | --------------- | ------------------------------------------------------------------- |
| `steps`                | `steps.countSum` (int64 string)                | `ACTIVITY_STEPS`           | steps   | `steps`         | daily total; 0 valid                                                |
| `distance`             | `distance.millimetersSum` (int64 string) ÷1000 | `WALKING_RUNNING_DISTANCE` | m       | `distance`      | millimetres on the wire                                             |
| `active-energy-burned` | `activeEnergyBurned.kcalSum` (number)          | `ACTIVE_ENERGY_BURNED`     | kcal    | `active_energy` | **ACTIVE portion only** — NOT `total-calories` (which folds in BMR) |
| `floors`               | `floors.countSum` (int64 string)               | `FLIGHTS_CLIMBED`          | flights | `floors`        | daily total; 0 valid; **no list method** — rollup is the only read  |

VO2 max is NOT a rollup type — `daily-vo2-max` is a daily summary read via list
(`daily_vo2_max.date` filter), value `dailyVo2Max.vo2Max`, strictly positive,
daily latest-wins, same `stats:`-style per-day overwrite key (`vo2_max`).

## Sleep bundle

Scope: `googlehealth.sleep.readonly`. Sleep sessions filter **only** on
`sleep.interval.end_time` (a night is fetched when it ENDS after the cursor).
The payload: `sleep.interval` (SessionTimeInterval — `startTime`/`endTime`
RFC-3339), `sleep.type` (`CLASSIC | STAGES`), `sleep.stages[]`
(`{startTime, startUtcOffset, endTime, endUtcOffset, type}`), and
`sleep.summary` (`minutesAsleep`/`minutesAwake`, int64 strings). HealthLog
stores one `SLEEP_DURATION` row per stage SEGMENT, `measuredAt = that segment's
END instant`, harmonised onto the shared `SleepStage` enum the night-total +
hypnogram readers consume. externalId = `<session-anchor>:sleep_<stage>:<i>`
(session `interval.endTime` ISO instant + indexed segment), so a re-scored night
overwrites in place. Stage map (`SLEEP_STAGE_TYPE` enum, lowercased):
`LIGHT → CORE` ("light" ↔ Apple "core" shallow-NREM band), `DEEP → DEEP`,
`REM → REM`, `AWAKE`/`RESTLESS → AWAKE`, classic `ASLEEP → ASLEEP`.
`SLEEP_STAGE_TYPE_UNSPECIFIED` / unknown labels are skipped, not mis-bucketed.

## Exercise bundle — Workouts

Scope: `googlehealth.activity_and_fitness.readonly`. Sessions filter **only** on
`exercise.interval.civil_start_time` with an offset-less civil bound (derived
from the watermark in the user's zone). Each exercise session → one `Workout`
row (NOT a Measurement), keyed `(userId, source: "GOOGLE_HEALTH", externalId)`
where externalId is the DataPoint's top-level `name` resource name (there is no
session-id field; `exercise:<startISO>` when absent). Fields: sportType
(`exercise.exerciseType` UPPERCASE enum → canonical `WorkoutSportType`, `other`
fallback), startedAt/endedAt from `exercise.interval.startTime/endTime`
(RFC-3339), durationSec, totalEnergyKcal
(`exercise.metricsSummary.caloriesKcal`), totalDistanceM
(`exercise.metricsSummary.distanceMillimeters` ÷ 1000), avgHeartRate
(`exercise.metricsSummary.averageHeartRateBeatsPerMinute`, int64 string).
metricsSummary carries **no max/min HR** → null. A Google Health run and the
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

## Error surfacing

Non-2xx Google Health bodies carry the AIP-193 envelope
(`{"error":{code,message,status}}`). The client extracts a redacted
`STATUS: message` detail (message capped at 200 chars, bearer tokens and URL
query strings stripped) into `GoogleHealthApiError.upstreamError` and the
external-call annotation, so a field-grammar 400 is diagnosable from operator
logs. The OAuth token endpoint uses the flat `{"error":"invalid_grant"}` shape
instead — handled separately in `postToken`.

## Structure probe

`POST /api/integrations/google-health/test` with body
`{"probe":"structure"}` fetches ONE recent page/window per data type and returns
only the JSON **structure** (field names + `typeof` leaves — never values), plus
the per-type error verdict on failure. Self-hoster diagnostics for payload-shape
drift.
