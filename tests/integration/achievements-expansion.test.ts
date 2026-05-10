/**
 * Integration test for the v1.4.18 achievement expansion.
 *
 * Drives a fresh Postgres user through the moments when expansion
 * predicates fire, verifying:
 *   - mood entries persisted as `MoodEntry` rows are picked up by
 *     `getMoodMetrics` (the row shape uses YYYY-MM-DD strings, not
 *     Date objects, which is the most common drift surface)
 *   - measurement counts are split by `MeasurementType` correctly
 *   - earnability flags reflect what the user actually has
 *
 * We don't drive the full HTTP route here because the existing
 * `medication_schedules.days_of_week` migration drift makes the route
 * fail in the integration container; that's a pre-existing issue
 * tracked separately. Instead we round-trip the prisma rows through
 * `buildExpansionMetricValues` and `getEarnabilityFlags`, which is
 * the same code-path the route exercises after the fetch.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildExpansionMetricValues,
  getEarnabilityFlags,
} from "@/lib/gamification/expansion-metrics";

import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("achievements expansion — fresh user, real prisma rows", () => {
  it("recognises a single mood entry as `hasMood: true`", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "mood-tracker",
        email: "mood@example.test",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.moodEntry.create({
      data: {
        userId: user.id,
        date: "2026-04-15",
        mood: "GUT",
        score: 4,
        moodLoggedAt: new Date("2026-04-15T08:00:00Z"),
      },
    });

    const moodEntries = await prisma.moodEntry.findMany({
      where: { userId: user.id },
      select: { date: true, score: true, moodLoggedAt: true },
    });

    const result = buildExpansionMetricValues({
      measurements: [],
      moodEntries,
      intakeEvents: [],
      auditEvents: [],
    });

    expect(result.moodEntryCount).toBe(1);

    const flags = getEarnabilityFlags({
      hasMedication: false,
      moodEntryCount: result.moodEntryCount,
      measurementCounts: {
        weightCount: result.weightMeasurementCount,
        bpCount: result.bpMeasurementCount,
        pulseCount: result.pulseMeasurementCount,
      },
    });
    expect(flags.hasMood).toBe(true);
    expect(flags.hasWeight).toBe(false);
  });

  it("counts measurements by type from real DB rows", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "many-readings",
        email: "readings@example.test",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          measuredAt: new Date("2026-04-01T08:00:00Z"),
        },
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80.5,
          unit: "kg",
          measuredAt: new Date("2026-04-02T08:00:00Z"),
        },
        {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: 120,
          unit: "mmHg",
          measuredAt: new Date("2026-04-01T08:00:00Z"),
        },
        {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          value: 80,
          unit: "mmHg",
          measuredAt: new Date("2026-04-01T08:00:00Z"),
        },
        {
          userId: user.id,
          type: "PULSE",
          value: 65,
          unit: "bpm",
          measuredAt: new Date("2026-04-03T08:00:00Z"),
        },
      ],
    });

    const measurements = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: {
          in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "PULSE"],
        },
      },
      select: { type: true, measuredAt: true },
    });

    const result = buildExpansionMetricValues({
      measurements,
      moodEntries: [],
      intakeEvents: [],
      auditEvents: [],
    });

    expect(result.weightMeasurementCount).toBe(2);
    expect(result.bpMeasurementCount).toBe(1); // SYS canonical, DIA not double-counted
    expect(result.pulseMeasurementCount).toBe(1);
  });

  it("fires the doctor-PDF hidden trigger from a real audit-log row", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "exporter",
        email: "exporter@example.test",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "doctor-report.export",
      },
    });

    const auditEvents = await prisma.auditLog.findMany({
      where: { userId: user.id, action: "doctor-report.export" },
      select: { action: true, createdAt: true },
    });

    const result = buildExpansionMetricValues({
      measurements: [],
      moodEntries: [],
      intakeEvents: [],
      auditEvents,
    });

    expect(result.doctorPdfCount).toBe(1);
  });
});
