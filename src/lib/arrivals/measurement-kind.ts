/**
 * Measurement type → arrival kind mapping, shared by the three measurement
 * write seams (the batch route, and both arms of the interactive POST).
 *
 * Kept in one place because the mapping encodes a product judgement that must
 * not drift between seams: blood pressure is stored as TWO rows (a systolic and
 * a diastolic sharing one `measuredAt`) but is ONE reading to every reader, so
 * both types map to the same kind and a write that lands both produces a single
 * arrival.
 *
 * Types absent from the map are simply not part of the spine. That is the
 * default, and adding one is a deliberate act: a new kind also needs a surface
 * that consumes it and, if it can cause a provider call, a stated per-user
 * daily bound.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import type { ArrivalKind } from "./types";

export const ARRIVAL_MEASUREMENT_KIND: Partial<
  Record<MeasurementType, ArrivalKind>
> = {
  WEIGHT: "weight",
  BLOOD_PRESSURE_SYS: "blood_pressure",
  BLOOD_PRESSURE_DIA: "blood_pressure",
};

export interface ArrivalKindGroup {
  newestAt: Date;
  count: number;
}

/**
 * Collapse just-written measurement rows into at most one group per arrival
 * kind, carrying the newest timestamp and how many rows landed.
 *
 * The newest timestamp is what the classifier tests for recency, so a write
 * mixing a backfilled row with a fresh one is judged on the fresh one — which
 * is correct: the record genuinely did just gain something current.
 */
export function groupRowsByArrivalKind(
  rows: ReadonlyArray<{ type: MeasurementType; measuredAt: Date }>,
): Array<[ArrivalKind, ArrivalKindGroup]> {
  const groups = new Map<ArrivalKind, ArrivalKindGroup>();
  for (const row of rows) {
    const kind = ARRIVAL_MEASUREMENT_KIND[row.type];
    if (!kind) continue;
    if (Number.isNaN(row.measuredAt.getTime())) continue;
    const existing = groups.get(kind);
    if (!existing) {
      groups.set(kind, { newestAt: row.measuredAt, count: 1 });
      continue;
    }
    existing.count++;
    if (row.measuredAt.getTime() > existing.newestAt.getTime()) {
      existing.newestAt = row.measuredAt;
    }
  }
  return [...groups];
}
