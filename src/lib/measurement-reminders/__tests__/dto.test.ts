import { describe, it, expect } from "vitest";

import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";
import type { MeasurementReminder } from "@/generated/prisma/client";

function row(overrides: Partial<MeasurementReminder> = {}): MeasurementReminder {
  const now = new Date("2026-06-16T08:00:00.000Z");
  return {
    id: "r1",
    userId: "u1",
    label: "Measure your blood pressure twice a day for a week",
    measurementType: "BLOOD_PRESSURE_SYS",
    intervalDays: null,
    rrule: "FREQ=DAILY;BYHOUR=7,19;INTERVAL=1",
    anchorDate: null,
    endsOn: new Date("2026-06-23T08:00:00.000Z"),
    origin: "COACH",
    notifyHour: 7,
    location: null,
    nextDueAt: new Date("2026-06-16T19:00:00.000Z"),
    lastSatisfiedAt: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  } as MeasurementReminder;
}

describe("toMeasurementReminderDto", () => {
  it("echoes origin and endsOn (iOS contract)", () => {
    const dto = toMeasurementReminderDto(row());
    expect(dto.origin).toBe("COACH");
    expect(dto.endsOn).toBe("2026-06-23T08:00:00.000Z");
  });

  it("serialises a default VORSORGE open-ended reminder", () => {
    const dto = toMeasurementReminderDto(
      row({ origin: "VORSORGE", endsOn: null }),
    );
    expect(dto.origin).toBe("VORSORGE");
    expect(dto.endsOn).toBeNull();
  });
});
