/**
 * Adapter: derive the single-value `MeasurementType → FHIR coding` table from
 * the registry. Replaces the hand-maintained `MEASUREMENT_LOINC` literal in
 * `loinc-map.ts` — every signal that carries a `fhir` facet projects to one
 * entry keyed by its DB `MeasurementType`. Signals without a `fhir` facet are
 * absent (their value is surfaced as a local text concept elsewhere, or handled
 * by a dedicated builder, e.g. BP panel / glucose context).
 */
import type { LoincMapping } from "@/lib/fhir/loinc-map";
import { allSignals } from "@/lib/signals/registry";

/** The registry-derived `MEASUREMENT_LOINC`, keyed by `MeasurementType` string. */
export function deriveMeasurementLoinc(): Record<string, LoincMapping> {
  const entries: Array<[string, LoincMapping]> = [];
  for (const signal of allSignals()) {
    if (signal.kind === "biomarker") continue;
    if (!signal.fhir) continue;
    entries.push([
      signal.source.measurementType,
      {
        loinc: signal.fhir.loinc,
        display: signal.fhir.display,
        unit: signal.fhir.unit,
        category: signal.fhir.category,
      },
    ]);
  }
  return Object.fromEntries(entries);
}
