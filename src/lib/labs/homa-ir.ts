/**
 * v1.25 — HOMA-IR (Homeostatic Model Assessment of Insulin Resistance).
 *
 * A computed longevity marker derived from fasting glucose + fasting insulin —
 * NOT a stored biomarker catalog entry (BMI's derived-value precedent). Server-
 * authoritative per the parity rule: compute it here, never recompute on the
 * client. Pure + side-effect-free so it is trivially testable.
 *
 * Conventional-unit formula (fasting glucose mg/dL × fasting insulin µIU/mL ÷
 * 405) and the SI form (mmol/L × µIU/mL ÷ 22.5) are equivalent
 * (mg/dL ÷ 18 = mmol/L; 405 = 22.5 × 18). Population-dependent interpretive
 * bands (optimal < 1.0, early IR > 1.9, significant IR > 2.9) are applied at the
 * display edge, never asserted here. [HOMA-IR, PMC5033570].
 */

/** Interpretive band for a HOMA-IR index value (population-dependent guidance). */
export type HomaIrBand = "optimal" | "intermediate" | "elevated" | "high";

/**
 * Compute HOMA-IR from fasting glucose (mg/dL) and fasting insulin (µIU/mL).
 * Returns `null` when either input is missing or non-positive (the index is
 * undefined for a zero/negative reading).
 */
export function computeHomaIr(
  fastingGlucoseMgDl: number | null | undefined,
  fastingInsulinUiuMl: number | null | undefined,
): number | null {
  if (
    fastingGlucoseMgDl == null ||
    fastingInsulinUiuMl == null ||
    !Number.isFinite(fastingGlucoseMgDl) ||
    !Number.isFinite(fastingInsulinUiuMl) ||
    fastingGlucoseMgDl <= 0 ||
    fastingInsulinUiuMl <= 0
  ) {
    return null;
  }
  return (fastingGlucoseMgDl * fastingInsulinUiuMl) / 405;
}

/** Place a HOMA-IR value in its descriptive band (general guidance, not a diagnosis). */
export function classifyHomaIr(value: number): HomaIrBand {
  if (value < 1.0) return "optimal";
  if (value <= 1.9) return "intermediate";
  if (value <= 2.9) return "elevated";
  return "high";
}
