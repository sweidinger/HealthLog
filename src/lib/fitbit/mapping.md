# Fitbit / Google Health field → Measurement mapping

Single source of truth for the Fitbit (Google Health API v4) data-type →
HealthLog `Measurement` mapping. Keep this in sync with `FITBIT_FIELD_MAP` and
the per-type mappers in `client.ts`. Every Fitbit row ingests server-side with
`source = FITBIT` and `externalId = <anchor>:<fieldTag>` (the anchor is the data
point's sample time for spot readings or its civil date for daily summaries; the
field-tag disambiguates the metric).

Transport docs: `developers.google.com/health` (v4, post-Fitbit-Web-API). The
per-type value-field JSON is **NOT fully published** — the mappers read a small
set of candidate value paths defensively (`firstNumber` walks each shape and
takes the first finite-positive hit). **Re-verify against a live test account at
build** and tighten the extractors. Design: `.planning/v1.12.0-google-health-design.md`.

## Casing gotcha (design §A.1)

The data-type id is **kebab-case in the request path** (`body-fat`) and
**snake_case in the `filter` predicate** (`body_fat`). `FITBIT_DATA_TYPES` pins
both forms per type so a fetcher can never encode the wrong one.

## Health-metrics bundle (W3)

Scope: `googlehealth.health_metrics_and_measurements.readonly`.

| Data type (path / filter) | MeasurementType | Unit | fieldTag | Grain | Note |
|---|---|---|---|---|---|
| `weight` / `weight` | `WEIGHT` | kg | `weight` | sample | Picker ranks a real Withings scale above Fitbit. |
| `body-fat` / `body_fat` | `BODY_FAT` | % | `body_fat` | sample | |
| `daily-oxygen-saturation` / `daily_oxygen_saturation` | `OXYGEN_SATURATION` | % | `spo2` | daily | Already 0–100. |
| `daily-heart-rate-variability` / `daily_heart_rate_variability` | `HEART_RATE_VARIABILITY` | ms | `hrv` | daily | **Decision:** SDNN slot (Apple-comparable), NOT `HRV_RMSSD`. Fitbit reports an RMSSD-style nightly HRV — confirm the estimator at build and reconsider `HRV_RMSSD` if warranted. |
| `daily-resting-heart-rate` / `daily_resting_heart_rate` | `RESTING_HEART_RATE` | bpm | `rhr` | daily | |
| `daily-respiratory-rate` / `daily_respiratory_rate` | `RESPIRATORY_RATE` | breaths/min | `resp_rate` | daily | |
| `heart-rate` / `heart_rate` | `PULSE` | bpm | `hr` | sample | Intraday spot HR. |
| `daily-sleep-temperature-derivations` / `daily_sleep_temperature_derivations` | `WRIST_TEMPERATURE` | celsius | `wrist_temp` | daily | Closest semantic slot to Apple sleeping-wrist-temp. Confirm absolute-vs-baseline at build; the positive guard rejects a baseline-delta reading. |
| `height` / `height` | `User.heightCm` | cm | — | sample | Profile seed — written to `User.heightCm` ONLY when null; never minted as a Measurement (WHOOP `mapBody` pattern). m→cm when reported in metres. |

Every value passes a finite + strictly-positive guard (the launch metrics are
all positive — a zero/NaN is a garbage/empty reading and is dropped).

## Deferred (Google Health Q3-2026 roadmap — slots exist, NOT in launch set)

`blood-glucose` → `BLOOD_GLUCOSE`, `blood-pressure` → `BLOOD_PRESSURE_SYS`+`_DIA`,
`basal-body-temperature` → `BODY_TEMPERATURE`. These light up for free when
Google ships the data types.

## Later waves (W5)

`steps` → `ACTIVITY_STEPS`, `distance` → `WALKING_RUNNING_DISTANCE`,
`total-calories` → `ACTIVE_ENERGY_BURNED`, `floors` → `FLIGHTS_CLIMBED`,
`vo2-max`/`run-vo2-max` → `VO2_MAX`, `sleep` → per-stage `SLEEP_DURATION`,
`exercise` → `Workout` rows. `active-zone-minutes` is **skipped** at launch (no
slot; not blocking).

## Idempotency

`(userId, type, source: "FITBIT", externalId)` unique. `externalId =
<anchor>:<fieldTag>` — a re-fetch of the same window (daily summaries re-roll
after the fact, so the incremental overlap is 24 h) overwrites in place.
