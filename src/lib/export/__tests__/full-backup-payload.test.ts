import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMeasurementsPaged: vi.fn(),
  buildCycleBackupSection: vi.fn(),
  buildRecordsBackupSection: vi.fn(),
}));

vi.mock("@/lib/export/paged-measurements", () => ({
  findMeasurementsPaged: mocks.findMeasurementsPaged,
}));
vi.mock("@/lib/cycle/backup", () => ({
  buildCycleBackupSection: mocks.buildCycleBackupSection,
}));
vi.mock("@/lib/export/records-backup", () => ({
  buildRecordsBackupSection: mocks.buildRecordsBackupSection,
  countRecordsBackupSection: vi.fn(() => ({
    labResults: 0,
    biomarkers: 0,
    illnessEpisodes: 0,
    illnessDayLogs: 0,
    allergies: 0,
    familyHistory: 0,
    workouts: 0,
    documents: 0,
  })),
}));

import { buildFullBackupPayload } from "../full-backup-payload";

const deletedAt = new Date("2026-07-19T12:00:00.000Z");

function makePrisma() {
  return {
    medication: { findMany: vi.fn().mockResolvedValue([]) },
    medicationIntakeEvent: { findMany: vi.fn().mockResolvedValue([]) },
    moodEntry: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "mood-tombstone",
          date: "2026-07-19",
          mood: "OKAY",
          score: 3,
          tags: null,
          source: "MOODLOG",
          externalId: "moodlog-42",
          moodLoggedAt: new Date("2026-07-19T08:00:00.000Z"),
          deletedAt,
          tagLinks: [{ rating: 4, moodTag: { key: "sleep_quality" } }],
        },
      ]),
    },
  };
}

function installSectionMocks() {
  mocks.findMeasurementsPaged.mockResolvedValue([
    {
      id: "measurement-tombstone",
      type: "WEIGHT",
      value: 75,
      unit: "kg",
      measuredAt: new Date("2026-07-19T07:00:00.000Z"),
      source: "MANUAL",
      notes: null,
      notesEncrypted: null,
      deletedAt,
    },
  ]);
  mocks.buildCycleBackupSection.mockResolvedValue({
    cycleProfile: null,
    cycles: [],
    cycleDayLogs: [],
  });
  mocks.buildRecordsBackupSection.mockResolvedValue({
    labResults: [],
    biomarkers: [],
    illnessEpisodes: [],
    allergies: [],
    familyHistory: [],
    workouts: [],
    documents: [],
    manifest: {
      documents: { included: "encrypted-content", note: "included" },
      workouts: { included: "summary-only", note: "included" },
    },
  });
}

describe("buildFullBackupPayload disaster-recovery mode", () => {
  it("preserves measurement and mood tombstones with stable ids", async () => {
    installSectionMocks();
    const prisma = makePrisma();

    const { payload } = await buildFullBackupPayload(
      prisma as never,
      "user-1",
      {
        purpose: "disaster-recovery",
        exportedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    );

    expect(mocks.findMeasurementsPaged).toHaveBeenCalledWith(
      prisma,
      { userId: "user-1" },
      expect.objectContaining({ id: true, deletedAt: true }),
    );
    expect(prisma.moodEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
        include: expect.any(Object),
      }),
    );
    expect(mocks.buildRecordsBackupSection).toHaveBeenCalledWith(
      prisma,
      "user-1",
      { purpose: "disaster-recovery" },
    );
    expect(payload).toMatchObject({
      schemaVersion: "1",
      exportedAt: "2026-07-20T00:00:00.000Z",
      measurements: [
        {
          id: "measurement-tombstone",
          deletedAt: deletedAt.toISOString(),
        },
      ],
      moodEntries: [
        {
          id: "mood-tombstone",
          externalId: "moodlog-42",
          deletedAt: deletedAt.toISOString(),
          factors: [{ key: "sleep_quality", rating: 4 }],
        },
      ],
    });
  });
});
