/**
 * v1.25 — validated mental-health screener definitions (PHQ-9 + GAD-7).
 *
 * Pure, server-authoritative scoring. The instrument item wording, 0–3 scale,
 * totals, and severity bands are taken from the primary sources (Kroenke 2001
 * for PHQ-9; Spitzer 2006 for GAD-7). This module owns the canonical NUMERIC
 * contract; the human wording lives in `messages/*.json` under
 * `mentalHealth.items.*` (officially-validated translations per locale, English
 * fallback otherwise — re-wording invalidates the score).
 *
 * PHQ-9 item 9 (index 8) is the passive self-harm ideation screen and is the
 * safety-critical field (see `crisis-resources.ts` + the API handler): any
 * non-zero answer triggers a calm, non-alarmist crisis-resource signpost. The
 * raw item answers are NEVER exposed to the Coach / Insights / export surfaces —
 * only the derived total score rides a `*_SCORE` Measurement row.
 */

export type InstrumentId = "PHQ9" | "GAD7";

/**
 * Required attribution — render VERBATIM on every screen displaying the
 * instrument and in the PDF/FHIR export. The PHQ family is public-domain (Pfizer
 * 2010); this is the canonical footer text. By convention it stays in English
 * (the developers' names are not translated).
 */
export const PHQ_GAD_ATTRIBUTION =
  "Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and " +
  "colleagues, with an educational grant from Pfizer Inc. No permission " +
  "required to reproduce, translate, display or distribute.";

export interface InstrumentDefinition {
  id: InstrumentId;
  /** Number of scored items (PHQ-9 = 9, GAD-7 = 7). */
  itemCount: number;
  /** Inclusive total range. */
  minScore: number;
  maxScore: number;
  /** Total-score LOINC for the FHIR/export contract. */
  totalLoinc: string;
  /** Severity bands, ordered low→high. `min`/`max` inclusive over the total. */
  bands: ReadonlyArray<{ key: string; min: number; max: number }>;
  /** Optimal screening cut-off (≥ this total = consider professional follow-up). */
  actionThreshold: number;
  /** Item index (0-based) of the safety-critical self-harm item, or null. */
  safetyItemIndex: number | null;
}

const PHQ9: InstrumentDefinition = {
  id: "PHQ9",
  itemCount: 9,
  minScore: 0,
  maxScore: 27,
  totalLoinc: "44261-6",
  bands: [
    { key: "minimal", min: 0, max: 4 },
    { key: "mild", min: 5, max: 9 },
    { key: "moderate", min: 10, max: 14 },
    { key: "modSevere", min: 15, max: 19 },
    { key: "severe", min: 20, max: 27 },
  ],
  actionThreshold: 10,
  // Item 9 ("Thoughts that you would be better off dead…") — the safety field.
  safetyItemIndex: 8,
};

const GAD7: InstrumentDefinition = {
  id: "GAD7",
  itemCount: 7,
  minScore: 0,
  maxScore: 21,
  totalLoinc: "70274-6",
  bands: [
    { key: "minimal", min: 0, max: 4 },
    { key: "mild", min: 5, max: 9 },
    { key: "moderate", min: 10, max: 14 },
    { key: "severe", min: 15, max: 21 },
  ],
  actionThreshold: 10,
  safetyItemIndex: null,
};

export const INSTRUMENTS: Record<InstrumentId, InstrumentDefinition> = {
  PHQ9,
  GAD7,
};

/** The DB MeasurementType the instrument's total score projects to. */
export const INSTRUMENT_MEASUREMENT_TYPE: Record<InstrumentId, string> = {
  PHQ9: "PHQ9_SCORE",
  GAD7: "GAD7_SCORE",
};

/** Sum the item answers into a total (server-authoritative). */
export function scoreTotal(items: readonly number[]): number {
  return items.reduce((sum, v) => sum + v, 0);
}

/** Resolve the severity-band key for a total score. */
export function severityBand(id: InstrumentId, total: number): string {
  const def = INSTRUMENTS[id];
  const band = def.bands.find((b) => total >= b.min && total <= b.max);
  // Defensive clamp — the API validates the total is in-range before this runs.
  return band?.key ?? def.bands[def.bands.length - 1].key;
}

/**
 * Whether the safety signpost must be shown for these answers. True iff the
 * instrument has a safety item and that item was answered with any non-zero
 * value — independent of the total score (item 9 is never gated by the band).
 */
export function isSafetyFlagged(
  id: InstrumentId,
  items: readonly number[],
): boolean {
  const idx = INSTRUMENTS[id].safetyItemIndex;
  if (idx === null) return false;
  return (items[idx] ?? 0) > 0;
}
