/**
 * Per-vital i18n label keys for the doctor report.
 *
 * Extracted from `doctor-report-pdf-core` so consumers that only need the
 * label map (e.g. the public clinician share view, a pure server component)
 * do not pull the jsPDF renderer into their module graph. The PDF core
 * re-exports this map so there is a single source of truth.
 *
 * Exported for coverage tests (issue #109 / phase P0) so a future enum
 * addition is caught by a unit test rather than reaching production as a raw
 * enum string in the PDF.
 */
export const DOCTOR_REPORT_TYPE_LABEL_KEYS: Record<string, string> = {
  WEIGHT: "doctorReport.typeWeight",
  BLOOD_PRESSURE_SYS: "doctorReport.typeBpSys",
  BLOOD_PRESSURE_DIA: "doctorReport.typeBpDia",
  PULSE: "doctorReport.typePulse",
  BODY_FAT: "doctorReport.typeBodyFat",
  SLEEP_DURATION: "doctorReport.typeSleep",
  ACTIVITY_STEPS: "doctorReport.typeSteps",
  TOTAL_BODY_WATER: "doctorReport.typeTotalBodyWater",
  BONE_MASS: "doctorReport.typeBoneMass",
  OXYGEN_SATURATION: "doctorReport.typeOxygenSaturation",
};
