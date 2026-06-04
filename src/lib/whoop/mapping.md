# WHOOP field → Measurement mapping

Single source of truth for the WHOOP v2 field → HealthLog `Measurement`
mapping. Keep this in sync with `WHOOP_FIELD_MAP` and the `mapRecovery` /
`mapSleep` / `mapCycle` mappers in `client.ts`. Every WHOOP row ingests
server-side with `source = WHOOP` and `externalId = <resource-uuid>:<fieldTag>`
(the field-tag disambiguates the several measurements derived from one WHOOP
resource). WHOOP rows tag `deviceType = band`.

Stance reference: `.planning/v1.11-build/epic-A-whoop-buildspec.md` §3.2 + §5.

## Recovery (`/v2/recovery`) — record `updated_at` is `measuredAt`

| Source field | MeasurementType | Unit | fieldTag | Note |
|---|---|---|---|---|
| `recovery.score.recovery_score` | `RECOVERY_SCORE` | score | `recovery` | Native WHOOP recovery. Same type as the COMPUTED proxy, distinguished by `source = WHOOP`. |
| `recovery.score.hrv_rmssd_milli` | `HRV_RMSSD` | ms | `hrv_rmssd` | RMSSD — kept distinct from the SDNN `HEART_RATE_VARIABILITY`. |
| `recovery.score.resting_heart_rate` | `RESTING_HEART_RATE` | bpm | `rhr` | Cross-source picker resolves WHOOP vs Apple vs Withings. |
| `recovery.score.spo2_percentage` | `OXYGEN_SATURATION` | % | `spo2` | Optional; already 0–100. |
| `recovery.score.skin_temp_celsius` | `SKIN_TEMPERATURE` | celsius | `skin_temp` | Optional; distinct from `BODY_TEMPERATURE`. |

A recovery record with `score === null` (WHOOP still scoring) maps to nothing.

## Sleep (`/v2/activity/sleep`) — record `end` is `measuredAt`

| Source field | MeasurementType | Unit | fieldTag | sleepStage |
|---|---|---|---|---|
| `stage_summary.total_light_sleep_time_milli` | `SLEEP_DURATION` | minutes | `sleep_core` | `CORE` |
| `stage_summary.total_slow_wave_sleep_time_milli` | `SLEEP_DURATION` | minutes | `sleep_deep` | `DEEP` |
| `stage_summary.total_rem_sleep_time_milli` | `SLEEP_DURATION` | minutes | `sleep_rem` | `REM` |
| `stage_summary.total_awake_time_milli` | `SLEEP_DURATION` | minutes | `sleep_awake` | `AWAKE` |
| `stage_summary.total_in_bed_time_milli` | `SLEEP_DURATION` | minutes | `sleep_in_bed` | `IN_BED` |
| `sleep_needed.{baseline,debt,strain,nap}_milli` (summed) | `SLEEP_NEED` | minutes | `sleep_need` | — |
| `sleep_performance_percentage` | `SLEEP_PERFORMANCE` | % | `sleep_perf` | — |
| `sleep_efficiency_percentage` | `SLEEP_EFFICIENCY` | % | `sleep_eff` | — |
| `sleep_consistency_percentage` | `SLEEP_CONSISTENCY` | % | `sleep_consistency` | — |
| `respiratory_rate` | `RESPIRATORY_RATE` | breaths/min | `resp_rate` | — |

Stage durations are ms→minutes (`÷ 60000`). One row per stage per night
(same pattern as Apple Health). Percentage / respiratory fields are optional.

## Cycle (`/v2/cycle`) — record `start` is `measuredAt`

| Source field | MeasurementType | Unit | fieldTag | Note |
|---|---|---|---|---|
| `cycle.score.strain` | `DAY_STRAIN` | score | `day_strain` | 0–21 WHOOP scale. Distinct from the COMPUTED `STRAIN_SCORE` (0–100 TRIMP proxy). |
| `cycle.score.kilojoule` | `ENERGY_EXPENDITURE_KJ` | kJ | `energy_kj` | Native kJ — NOT converted to kcal (the workout path converts). |

## Workout (`/v2/activity/workout`) — into `Workout`, not `Measurement`

| Source field | Destination | Unit | Note |
|---|---|---|---|
| `workout.score.strain` | `Workout.metadata` (`WORKOUT_STRAIN` type exists for the rare detached case) | score | Tied to the workout row so a phantom strain row never survives workout dedup. |
| `workout.score.kilojoule` | `Workout.totalEnergyKcal` | kcal | kJ→kcal (`÷ 4.184`). |
| `workout.score.{zone_durations,percent_recorded,distance_meter,altitude_*}` | `Workout.metadata` | — | HR-zone durations + recording quality + altitude. |

Workout ingest + dedup lands in W3/W6 (the E-slice); this module only owns the
fetch + the score→energy conversion factor (`KJ_TO_KCAL`).

## Body / profile (single objects, no pagination)

Ingested by `sync-body.ts` (`syncUserBody`), wired into the `syncUserWhoop`
loop + the backfill. The body endpoint is a single object, not a paginated
collection.

| Source field | Destination | Unit | Note |
|---|---|---|---|
| `body.weight_kilogram` | `WEIGHT` | kg | Source = WHOOP, STABLE externalId `whoop:body:weight` with overwrite semantics — a single self-reported profile value, not a time series, so a re-sync updates the same row rather than accumulating duplicates. `measuredAt` = the fetch time. Picker ranks a real scale above WHOOP. |
| `body.max_heart_rate` | `WhoopConnection.maxHeartRate` | bpm | Profile constant — stored on the connection, not a `Measurement`. |
| `body.height_meter` | `User.heightCm` | cm | Profile seed (m→cm). Written ONLY when `User.heightCm` is currently null — never overwrites a user-set height, never minted as a `Measurement`. |

## Blood pressure — watch-only

Blood pressure is API-invisible: the WHOOP public developer API (v2) exposes no
BP field, endpoint, or scope. WHOOP's Blood Pressure Insights are WHOOP MG
hardware + WHOOP Life membership + cuff-calibrated and live only in the WHOOP
app. No server-side code. If WHOOP ever ships an API surface it reuses the
existing `BLOOD_PRESSURE_SYS` / `BLOOD_PRESSURE_DIA` types — no new enum, no
migration. Re-check developer.whoop.com/docs/api-changelog periodically.
