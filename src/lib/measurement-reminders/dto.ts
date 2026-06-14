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
