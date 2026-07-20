import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    moodEntry: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((value: string) => value),
}));

vi.mock("@/lib/validations/notifications", () => ({
  isPublicUrl: vi.fn(() => true),
}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: vi.fn(),
}));

vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn(),
  recordSyncFailure: vi.fn(),
  recordSyncSuccess: vi.fn(),
}));

vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeUserMoodRollups: vi.fn(),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: vi.fn(() => ({
    addExternalCall: vi.fn(),
    addWarning: vi.fn(),
  })),
}));

import { prisma } from "@/lib/db";
import {
  isReauthRequired,
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";
import { safeFetch } from "@/lib/safe-fetch";
import { syncMoodLogEntries } from "../sync";

const SOURCE_ENTRY = {
  id: "provider-event-1",
  date: "2026-07-19",
  time: "2026-07-19T08:30:00.000Z",
  mood: "GUT",
  score: 4,
  tags: ["walk"],
};

describe("syncMoodLogEntries persistence completion", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      moodLogEnabled: true,
      moodLogUrlEncrypted: "https://moodlog.example.test",
      moodLogApiKeyEncrypted: "api-key",
      moodLogLastSyncedAt: new Date("2026-07-18T08:30:00.000Z"),
    } as never);
    vi.mocked(isReauthRequired).mockResolvedValue(false);
    vi.mocked(safeFetch).mockResolvedValue(
      new Response(JSON.stringify({ version: "1", entries: [SOURCE_ENTRY] }), {
        status: 200,
      }),
    );
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  });

  it("holds the watermark and success marker when a source upsert fails", async () => {
    const persistenceError = new Error("database unavailable");
    vi.mocked(prisma.moodEntry.upsert).mockRejectedValueOnce(persistenceError);

    await expect(syncMoodLogEntries("user-1")).rejects.toThrow(
      "database unavailable",
    );

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(recordSyncSuccess).not.toHaveBeenCalled();
    expect(recordSyncFailure).toHaveBeenCalledWith({
      userId: "user-1",
      integration: "moodlog",
      kind: "transient",
      message: "database unavailable",
      errorCode: "persistence_failed",
    });
  });
});
