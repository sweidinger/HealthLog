/**
 * v1.20.0 (F1) — CoachScopeSource → snapshot section key map.
 *
 * `get_metric_series` fetches a single metric by re-running the snapshot
 * builder scoped to that one source, then reads the matching section out of the
 * structured `CoachSnapshotResult.sections`. The builder names each section by
 * a camelCase key (e.g. `heartRateVariability`); this map mirrors the
 * `valueBlocks` table in `snapshot.ts` plus the three core clinical blocks
 * (bloodPressure / weight / pulse) and the mood block.
 *
 * `glucose` and `workouts` are intentionally absent: they have dedicated tools
 * / branches (glucose carries the clinical panel; workouts is deferred). A
 * `get_metric_series` call for one of them resolves to `null` here and the
 * executor returns `{ present: false }` with a pointer to the right tool.
 *
 * The `source-keys.test.ts` guard asserts every `coachScopeSourceSchema` value
 * either resolves here or is explicitly one of the dedicated-tool sources, so a
 * future source addition cannot silently fall through to a fabricated answer.
 */
import type { CoachScopeSource } from "@/lib/ai/coach/types";

/** Sources that `get_metric_series` does NOT serve (they have own tools). */
export const METRIC_SERIES_EXCLUDED_SOURCES: ReadonlySet<CoachScopeSource> =
  new Set<CoachScopeSource>(["glucose", "workouts", "compliance"]);

/** source → the snapshot section key its single-metric block lands under. */
export const COACH_SOURCE_SNAPSHOT_KEY: Readonly<
  Partial<Record<CoachScopeSource, string>>
> = {
  // ── core clinical ──
  bp: "bloodPressure",
  weight: "weight",
  pulse: "pulse",
  mood: "mood",
  // ── cardio ──
  hrv: "heartRateVariability",
  resting_hr: "restingHeartRate",
  walking_hr: "walkingHeartRateAverage",
  respiratory_rate: "respiratoryRate",
  spo2: "oxygenSaturation",
  pulse_wave_velocity: "pulseWaveVelocity",
  vascular_age: "vascularAge",
  // ── body composition ──
  body_fat: "bodyFat",
  fat_mass: "fatMass",
  fat_free_mass: "fatFreeMass",
  muscle_mass: "muscleMass",
  lean_body_mass: "leanBodyMass",
  bone_mass: "boneMass",
  total_body_water: "totalBodyWater",
  bmi: "bodyMassIndex",
  visceral_fat: "visceralFat",
  // ── activity ──
  steps: "steps",
  active_energy: "activeEnergy",
  flights: "flightsClimbed",
  distance: "walkingRunningDistance",
  vo2_max: "vo2Max",
  // ── mobility & gait ──
  walking_steadiness: "walkingSteadiness",
  walking_asymmetry: "walkingAsymmetry",
  walking_double_support: "walkingDoubleSupport",
  walking_step_length: "walkingStepLength",
  walking_speed: "walkingSpeed",
  // ── environment / exposure ──
  audio_env: "audioExposureEnvironment",
  audio_headphone: "audioExposureHeadphone",
  audio_event: "audioExposureEvent",
  daylight: "timeInDaylight",
  skin_temp: "skinTemperature",
  // ── sleep (also has the dedicated get_sleep tool, but the raw duration
  //    series is reachable here too) ──
  sleep: "sleep",
  body_temp: "bodyTemperature",
};
