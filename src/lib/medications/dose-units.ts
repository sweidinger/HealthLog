/**
 * Canonical dose-unit key list — the single source of truth shared by the
 * wizard's dose step (the unit `<Select>`) and the display-time
 * {@link formatDose} helper. Keep both in lock-step by importing from here;
 * never re-declare the array.
 *
 * Ordered so mg / ml / IE / µg lead and the device-form units
 * (Tablette, Hub, Sprühstoß, …) follow. Mirrors the v1.5.3 list with the
 * maintainer-requested order tightening.
 *
 * Each key resolves to a localised label at
 * `medications.wizard.steps.step3.unit.<key>` in every locale bundle.
 */
export const DOSE_UNIT_KEYS = [
  "mg",
  "ml",
  "iu",
  "mcg",
  "g",
  "tablets",
  "capsules",
  "drops",
  "puffs",
  "sprays",
  "pieces",
  "other",
] as const;
