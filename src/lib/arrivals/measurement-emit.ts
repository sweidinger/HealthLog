import type { MeasurementType } from "@/generated/prisma/client";

import { emitDataArrival } from "./emit-shared";
import { groupRowsByArrivalKind } from "./measurement-kind";

export interface InsertedMeasurementArrivalRow {
  type: MeasurementType;
  measuredAt: Date;
  id?: string;
}

/**
 * Emit at most one arrival per supported measurement kind for rows a writer
 * proved it freshly inserted. Existing-row updates must never enter this list.
 */
export async function emitInsertedMeasurementArrivals(
  userId: string,
  rows: ReadonlyArray<InsertedMeasurementArrivalRow>,
  source: string,
): Promise<void> {
  for (const [kind, group] of groupRowsByArrivalKind(rows)) {
    const newest = rows
      .filter(
        (row) =>
          row.measuredAt.getTime() === group.newestAt.getTime() &&
          ((kind === "weight" && row.type === "WEIGHT") ||
            (kind === "blood_pressure" &&
              (row.type === "BLOOD_PRESSURE_SYS" ||
                row.type === "BLOOD_PRESSURE_DIA"))),
      )
      .at(0);
    await emitDataArrival({
      userId,
      kind,
      newestSampleAt: group.newestAt,
      insertedCount: group.count,
      refId: newest?.id,
      source,
    });
  }
}
