/**
 * Adapter: derive the correlation engine's bucketed-type list from the
 * registry. Replaces the hand-maintained `BUCKETED_TYPES` literal in
 * `features.ts` — every signal flagged `surfaces.correlationEligible` projects
 * to its DB `MeasurementType`. The list is consumed as a membership/iteration
 * set (each type is read independently), so order is not semantically
 * significant; the registry-invariant test compares it as a set.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { allSignals } from "@/lib/signals/registry";

/** The registry-derived correlation-eligible `MeasurementType` list. */
export function deriveBucketedTypes(): MeasurementType[] {
  const types: MeasurementType[] = [];
  for (const signal of allSignals()) {
    // biomarker (labs path) + environment (W-ENV exposure channels) are not
    // `MeasurementType`-backed — env feeds the engine through its own series
    // builder, not the measurement-keyed bucketed types.
    if (signal.kind === "biomarker" || signal.kind === "environment") continue;
    if (!signal.surfaces.correlationEligible) continue;
    types.push(signal.source.measurementType);
  }
  return types;
}
