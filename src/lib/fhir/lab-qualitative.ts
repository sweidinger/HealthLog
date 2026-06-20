/**
 * v1.18.9 — qualitative lab result → SNOMED CT concept (or honest text-only).
 *
 * A qualitative serology result ("negativ" / "positiv" / "nicht nachweisbar")
 * has no number, so its FHIR Observation carries a `valueCodeableConcept`
 * instead of a `valueQuantity`. This module maps the common German / English
 * result terms onto a small set of WELL-ESTABLISHED SNOMED CT qualifier-value
 * concepts. The raw recorded text ALWAYS rides `.text`; a coded `coding` is
 * added only when the term resolves CONFIDENTLY. When in doubt the result stays
 * text-only — never a fabricated code — mirroring the conservative stance of
 * the `lab-loinc` and `illness-snomed` mappers.
 *
 * Concepts (SNOMED CT International, qualifier value, REFERENCED not
 * redistributed per the licence):
 *   - 260385009  "Negative"     — negativ / negative
 *   - 10828004   "Positive"     — positiv / positive
 *   - 260415000  "Not detected" — nicht nachweisbar / not detected
 *   - 260373001  "Detected"     — nachweisbar / detected
 *
 * Borderline / grenzwertig is DELIBERATELY left text-only: the candidate
 * "Borderline" qualifier concept could not be confidently verified, and an
 * unverified code is worse than an honest `.text`. Any unrecognised term
 * likewise stays text-only.
 *
 * Systems: SNOMED CT — http://snomed.info/sct
 */

import type { FhirCodeableConcept } from "@/lib/fhir/types";

/**
 * SNOMED CT system URI. Inlined (rather than imported from `resources.ts`) to
 * keep this leaf module free of the heavy `resources.ts` import graph and avoid
 * an import cycle — `resources.ts` consumes THIS module.
 */
const SNOMED_SYSTEM = "http://snomed.info/sct";

interface QualitativeConcept {
  code: string;
  display: string;
}

/**
 * Normalised result term → SNOMED qualifier-value concept. The left side is the
 * lower-cased, whitespace-collapsed recorded text. Only confidently-known terms
 * appear; everything else falls through to text-only.
 */
const QUALITATIVE_SNOMED: Record<string, QualitativeConcept> = {
  // Negative-like
  negativ: { code: "260385009", display: "Negative" },
  negative: { code: "260385009", display: "Negative" },
  neg: { code: "260385009", display: "Negative" },
  "nicht nachweisbar": { code: "260415000", display: "Not detected" },
  "not detected": { code: "260415000", display: "Not detected" },
  // Positive-like
  positiv: { code: "10828004", display: "Positive" },
  positive: { code: "10828004", display: "Positive" },
  pos: { code: "10828004", display: "Positive" },
  nachweisbar: { code: "260373001", display: "Detected" },
  detected: { code: "260373001", display: "Detected" },
};

/** Collapse a recorded qualitative term to a lookup key. */
function normaliseQualitativeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Build the `valueCodeableConcept` for a qualitative lab result. The raw text
 * always rides `.text`; a SNOMED `coding` is added only for a confidently-
 * recognised term. Borderline / grenzwertig and any unknown term stay
 * text-only.
 */
export function qualitativeValueConcept(
  valueText: string,
): FhirCodeableConcept {
  const concept = QUALITATIVE_SNOMED[normaliseQualitativeKey(valueText)];
  if (!concept) {
    return { text: valueText };
  }
  return {
    coding: [
      { system: SNOMED_SYSTEM, code: concept.code, display: concept.display },
    ],
    text: valueText,
  };
}
