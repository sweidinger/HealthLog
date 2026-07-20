import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildRecordsBackupSection: vi.fn(),
  encrypt: vi.fn((value: string) => value),
  getWorkerPrisma: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/export/records-backup", () => ({
  buildRecordsBackupSection: mocks.buildRecordsBackupSection,
}));

vi.mock("@/lib/cycle/backup", () => ({
  buildCycleBackupSection: vi.fn().mockResolvedValue({
    cycleProfile: null,
    cycles: [],
    cycleDayLogs: [],
  }),
}));

vi.mock("@/lib/crypto", () => ({ encrypt: mocks.encrypt }));

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: vi.fn(
    async (_name: string, run: (event: object) => Promise<void>) =>
      run({
        addMeta: vi.fn(),
        addWarning: vi.fn(),
        setBackground: vi.fn(),
        setError: vi.fn(),
      }),
  ),
}));

vi.mock("../shared", () => ({
  getWorkerPrisma: mocks.getWorkerPrisma,
}));

import { handleDataBackup } from "../backup-handlers";

const documentCiphertext = Buffer.from([1, 2, 3, 4]).toString("base64");

function buildPrismaMock() {
  return {
    user: {
      findMany: vi.fn().mockResolvedValue([
        { id: "user-dr", username: "backup-owner" },
      ]),
    },
    measurement: { findMany: vi.fn().mockResolvedValue([]) },
    medication: { findMany: vi.fn().mockResolvedValue([]) },
    medicationIntakeEvent: { findMany: vi.fn().mockResolvedValue([]) },
    moodEntry: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "mood-dr",
          date: "2026-07-01",
          mood: "GUT",
          score: 4,
          tags: null,
          source: "MOODLOG",
          externalId: "mood-external-dr",
          moodLoggedAt: new Date("2026-07-01T20:00:00.000Z"),
          tagLinks: [
            { rating: 5, moodTag: { key: "sleep_quality" } },
          ],
        },
      ]),
    },
    dataBackup: { upsert: mocks.upsert },
  };
}

describe("handleDataBackup canonical DR payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkerPrisma.mockReturnValue(buildPrismaMock());
    mocks.upsert.mockResolvedValue({});
    mocks.buildRecordsBackupSection.mockResolvedValue({
      labResults: [],
      biomarkers: [],
      illnessEpisodes: [],
      allergies: [],
      familyHistory: [],
      workouts: [],
      documents: [
        {
          id: "document-dr",
          kind: "OTHER",
          title: null,
          filename: "record.pdf",
          mimeType: "application/pdf",
          byteSize: 4,
          status: "STORED",
          reportDate: null,
          documentDate: null,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
          contentEncrypted: documentCiphertext,
          contentSha256: null,
          contentCodec: "binary2",
          providerType: null,
          errorReason: null,
          summaryEncrypted: null,
          summaryGeneratedAt: null,
          summaryState: "NONE",
        },
      ],
      manifest: {
        documents: {
          included: "encrypted-content",
          note: "Encrypted content included",
        },
        workouts: { included: "summary-only", note: "Summary only" },
      },
    });
  });

  it("requests canonical records and serializes rated mood factors", async () => {
    await handleDataBackup([]);

    expect(mocks.buildRecordsBackupSection).toHaveBeenCalledWith(
      expect.anything(),
      "user-dr",
      { purpose: "disaster-recovery" },
    );
    expect(mocks.upsert).toHaveBeenCalledOnce();
    const encrypted = mocks.upsert.mock.calls[0]![0].create.data as string;
    const payload = JSON.parse(encrypted) as {
      moodEntries: Array<{
        id: string;
        externalId: string;
        factors: Array<{ key: string; rating: number }>;
      }>;
      documents: Array<{ contentEncrypted: string; contentCodec: string }>;
    };
    expect(payload.moodEntries).toEqual([
      expect.objectContaining({
        id: "mood-dr",
        externalId: "mood-external-dr",
        factors: [{ key: "sleep_quality", rating: 5 }],
      }),
    ]);
    expect(payload.documents).toEqual([
      expect.objectContaining({
        contentEncrypted: documentCiphertext,
        contentCodec: "binary2",
      }),
    ]);
  });
});
