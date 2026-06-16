/**
 * v1.17.1 — DTO serializer for Vorsorge (measurement) reminders.
 *
 * Maps the Prisma `MeasurementReminder` row onto the canonical
 * `MeasurementReminderDTO` the web list, dashboard tile, and iOS client
 * all mirror. Dates serialise to ISO-8601 with offset.
 */
import type { MeasurementReminder } from "@/generated/prisma/client";
import type { MeasurementReminderType } from "@/lib/validations/measurement-reminders";

export interface MeasurementReminderDtoShape {
  id: string;
  label: string;
  measurementType: MeasurementReminderType | null;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: string | null;
  /**
   * v1.18.1 — optional course-window end (ISO-8601). NULL ⇒ open-ended.
   * A Coach-suggested time-boxed protocol carries a non-NULL value and
   * self-expires.
   */
  endsOn: string | null;
  /**
   * v1.18.1 — provenance: `VORSORGE` (user-created) or `COACH` (minted from
   * a Coach cadence suggestion). The UI labels the source.
   */
  origin: "VORSORGE" | "COACH";
  notifyHour: number;
  location: string | null;
  nextDueAt: string | null;
  lastSatisfiedAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toMeasurementReminderDto(
  row: MeasurementReminder,
): MeasurementReminderDtoShape {
  return {
    id: row.id,
    label: row.label,
    measurementType: row.measurementType as MeasurementReminderType | null,
    intervalDays: row.intervalDays,
    rrule: row.rrule,
    anchorDate: row.anchorDate ? row.anchorDate.toISOString() : null,
    endsOn: row.endsOn ? row.endsOn.toISOString() : null,
    origin: row.origin,
    notifyHour: row.notifyHour,
    location: row.location,
    nextDueAt: row.nextDueAt ? row.nextDueAt.toISOString() : null,
    lastSatisfiedAt: row.lastSatisfiedAt
      ? row.lastSatisfiedAt.toISOString()
      : null,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
