/**
 * Per-measurement-type display metadata for the measurements list view.
 *
 * Extracted into its own module so we can:
 *   1. Run a coverage test that asserts every Zod-enum measurement type has
 *      an entry in every map (so future enum additions can't silently fall
 *      through to the raw-string fallback — which was the root cause of
 *      issue #109).
 *   2. Reuse the same icon/color set in adjacent surfaces (mobile list,
 *      edit dialog) without re-declaring it.
 *
 * Lead-architect note: this is the first step toward a single
 * `metrics.json` manifest the entire ecosystem derives from. Today this
 * module covers list-UI; phase P5 will subsume it into a cross-repo
 * manifest.
 */
import {
  Scale,
  Heart,
  Activity,
  Droplets,
  Droplet,
  Moon,
  Footprints,
  Bone,
  Wind,
  HeartPulse,
  Flame,
  TrendingUp,
  Thermometer,
  Gauge,
  type LucideIcon,
} from "lucide-react";

export const MEASUREMENT_TYPE_LABEL_KEYS: Record<string, string> = {
  WEIGHT: "measurements.typeWeight",
  BLOOD_PRESSURE_SYS: "measurements.typeBpSys",
  BLOOD_PRESSURE_DIA: "measurements.typeBpDia",
  PULSE: "measurements.typePulse",
  BODY_FAT: "measurements.typeBodyFat",
  SLEEP_DURATION: "measurements.typeSleep",
  ACTIVITY_STEPS: "measurements.typeSteps",
  BLOOD_GLUCOSE: "measurements.typeBloodGlucose",
  TOTAL_BODY_WATER: "measurements.typeTotalBodyWater",
  BONE_MASS: "measurements.typeBoneMass",
  OXYGEN_SATURATION: "measurements.typeOxygenSaturation",
  // ── v1.4.23 Apple Health additions ──
  HEART_RATE_VARIABILITY: "measurements.typeHeartRateVariability",
  RESTING_HEART_RATE: "measurements.typeRestingHeartRate",
  ACTIVE_ENERGY_BURNED: "measurements.typeActiveEnergyBurned",
  FLIGHTS_CLIMBED: "measurements.typeFlightsClimbed",
  WALKING_RUNNING_DISTANCE: "measurements.typeWalkingRunningDistance",
  VO2_MAX: "measurements.typeVo2Max",
  BODY_TEMPERATURE: "measurements.typeBodyTemperature",
};

export const MEASUREMENT_TYPE_ICONS: Record<string, LucideIcon> = {
  WEIGHT: Scale,
  BLOOD_PRESSURE_SYS: Heart,
  BLOOD_PRESSURE_DIA: Heart,
  PULSE: Activity,
  BODY_FAT: Droplets,
  SLEEP_DURATION: Moon,
  ACTIVITY_STEPS: Footprints,
  BLOOD_GLUCOSE: Droplet,
  TOTAL_BODY_WATER: Droplet,
  BONE_MASS: Bone,
  OXYGEN_SATURATION: Wind,
  // ── v1.4.23 Apple Health additions ──
  HEART_RATE_VARIABILITY: HeartPulse,
  RESTING_HEART_RATE: Heart,
  ACTIVE_ENERGY_BURNED: Flame,
  FLIGHTS_CLIMBED: TrendingUp,
  WALKING_RUNNING_DISTANCE: Footprints,
  VO2_MAX: Gauge,
  BODY_TEMPERATURE: Thermometer,
};

export const MEASUREMENT_TYPE_COLORS: Record<string, string> = {
  WEIGHT: "bg-chart-1/20 text-chart-1",
  BLOOD_PRESSURE_SYS: "bg-chart-3/20 text-chart-3",
  BLOOD_PRESSURE_DIA: "bg-chart-3/20 text-chart-3",
  PULSE: "bg-chart-5/20 text-chart-5",
  BODY_FAT: "bg-chart-4/20 text-chart-4",
  SLEEP_DURATION: "bg-chart-2/20 text-chart-2",
  ACTIVITY_STEPS: "bg-chart-2/20 text-chart-2",
  BLOOD_GLUCOSE: "bg-chart-3/20 text-chart-3",
  TOTAL_BODY_WATER: "bg-chart-2/20 text-chart-2",
  BONE_MASS: "bg-chart-4/20 text-chart-4",
  OXYGEN_SATURATION: "bg-chart-5/20 text-chart-5",
  // ── v1.4.23 Apple Health additions ──
  HEART_RATE_VARIABILITY: "bg-chart-5/20 text-chart-5",
  RESTING_HEART_RATE: "bg-chart-3/20 text-chart-3",
  ACTIVE_ENERGY_BURNED: "bg-chart-4/20 text-chart-4",
  FLIGHTS_CLIMBED: "bg-chart-2/20 text-chart-2",
  WALKING_RUNNING_DISTANCE: "bg-chart-2/20 text-chart-2",
  VO2_MAX: "bg-chart-1/20 text-chart-1",
  BODY_TEMPERATURE: "bg-chart-4/20 text-chart-4",
};
