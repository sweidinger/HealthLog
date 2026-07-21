import type { DrugProfile } from "./types";
import { STIMULANT_ADHD_PROFILE } from "./stimulant-adhd";

/**
 * Drug-profile registry, keyed by `Medication.treatmentClass`. A class with a
 * profile gets the tailored surfaces (daily check-in, target-symptom tracking);
 * a class without one behaves exactly as before. Additive — new classes drop a
 * profile in here.
 */
const PROFILES_BY_TREATMENT_CLASS: Readonly<Record<string, DrugProfile>> = {
  STIMULANT: STIMULANT_ADHD_PROFILE,
};

/** The drug profile for a treatment class, or null when the class has none. */
export function profileForTreatmentClass(
  treatmentClass: string | null | undefined,
): DrugProfile | null {
  if (!treatmentClass) return null;
  return PROFILES_BY_TREATMENT_CLASS[treatmentClass] ?? null;
}

/** True when the medication's class has a tailored drug profile. */
export function hasDrugProfile(
  treatmentClass: string | null | undefined,
): boolean {
  return profileForTreatmentClass(treatmentClass) !== null;
}
