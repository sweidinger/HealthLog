import { describe, expect, it, vi } from "vitest";

import { buildCycleBackupSection } from "../backup";

const deletedAt = new Date("2026-07-19T12:00:00.000Z");
const createdAt = new Date("2026-07-01T08:00:00.000Z");
const updatedAt = new Date("2026-07-19T11:00:00.000Z");

describe("buildCycleBackupSection disaster-recovery mode", () => {
  it("preserves stable ids, reconciliation fields, and tombstones", async () => {
    const prisma = {
      cycleProfile: {
        findUnique: vi.fn().mockResolvedValue({
          id: "profile-dr",
          goal: "GENERAL_HEALTH",
          cycleTrackingEnabled: true,
          typicalCycleLength: 28,
          typicalPeriodLength: 5,
          lutealPhaseLength: 14,
          secondarySymptom: "MUCUS",
          predictionEnabled: true,
          rawChartMode: false,
          discreetNotifications: true,
          sensitiveCategoryEncryption: true,
          createdAt,
          updatedAt,
        }),
      },
      menstrualCycle: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "cycle-dr",
            startDate: "2026-07-01",
            endDate: "2026-07-28",
            periodEndDate: "2026-07-05",
            lengthDays: 28,
            ovulationDate: "2026-07-14",
            ovulationConfirmed: true,
            isPredicted: false,
            tz: "Europe/London",
            syncVersion: 5,
            deletedAt,
            createdAt,
            updatedAt,
          },
        ]),
      },
      cycleDayLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "cycle-day-dr",
            date: "2026-07-02",
            cycleId: "cycle-dr",
            flow: "HEAVY",
            intermenstrualBleeding: false,
            basalBodyTempC: 36.7,
            temperatureExcluded: true,
            ovulationTest: "NEGATIVE",
            cervicalMucus: "CREAMY",
            cervixPosition: "LOW",
            cervixFirmness: "FIRM",
            cervixOpening: "CLOSED",
            sexualActivity: false,
            protectedSex: null,
            pregnancyTest: null,
            progesteroneTest: null,
            contraceptive: null,
            sensitiveEncrypted: "sensitive-ciphertext",
            notesEncrypted: "notes-ciphertext",
            source: "APPLE_HEALTH",
            externalId: "cycle-day-external",
            tz: "Europe/London",
            syncVersion: 9,
            deletedAt,
            createdAt,
            updatedAt,
            symptomLinks: [{ symptom: { key: "cramps" } }],
          },
        ]),
      },
    };

    const section = await buildCycleBackupSection(
      prisma as never,
      "user-1",
      { purpose: "disaster-recovery" },
    );

    expect(prisma.menstrualCycle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(prisma.cycleDayLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(section.cycleProfile).toEqual({
      id: "profile-dr",
      goal: "GENERAL_HEALTH",
      cycleTrackingEnabled: true,
      typicalCycleLength: 28,
      typicalPeriodLength: 5,
      lutealPhaseLength: 14,
      secondarySymptom: "MUCUS",
      predictionEnabled: true,
      rawChartMode: false,
      discreetNotifications: true,
      sensitiveCategoryEncryption: true,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(section.cycles[0]).toEqual({
      id: "cycle-dr",
      startDate: "2026-07-01",
      endDate: "2026-07-28",
      periodEndDate: "2026-07-05",
      lengthDays: 28,
      ovulationDate: "2026-07-14",
      ovulationConfirmed: true,
      isPredicted: false,
      tz: "Europe/London",
      syncVersion: 5,
      deletedAt: deletedAt.toISOString(),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(section.cycleDayLogs[0]).toEqual({
      id: "cycle-day-dr",
      date: "2026-07-02",
      cycleId: "cycle-dr",
      flow: "HEAVY",
      intermenstrualBleeding: false,
      basalBodyTempC: 36.7,
      temperatureExcluded: true,
      ovulationTest: "NEGATIVE",
      cervicalMucus: "CREAMY",
      cervixPosition: "LOW",
      cervixFirmness: "FIRM",
      cervixOpening: "CLOSED",
      sexualActivity: false,
      protectedSex: null,
      pregnancyTest: null,
      progesteroneTest: null,
      contraceptive: null,
      sensitiveEncrypted: "sensitive-ciphertext",
      notesEncrypted: "notes-ciphertext",
      source: "APPLE_HEALTH",
      externalId: "cycle-day-external",
      tz: "Europe/London",
      syncVersion: 9,
      deletedAt: deletedAt.toISOString(),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      symptomKeys: ["cramps"],
    });
  });
});
