import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { syncUserEcg } = vi.hoisted(() => ({
  syncUserEcg:
    vi.fn<
      (
        userId: string,
        options?: { startdate?: number; enddate?: number },
      ) => Promise<number>
    >(),
}));

vi.mock("@/lib/withings/sync-ecg", () => ({
  syncUserEcg: (
    userId: string,
    options?: { startdate?: number; enddate?: number },
  ) => syncUserEcg(userId, options),
}));
vi.mock("@/lib/withings/sync", () => ({
  syncUserMeasurements: vi.fn(async () => 0),
}));
vi.mock("@/lib/withings/sync-activity", () => ({
  syncUserActivity: vi.fn(async () => 0),
}));
vi.mock("@/lib/withings/sync-sleep", () => ({
  syncUserSleep: vi.fn(async () => 0),
}));
vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn(async () => undefined),
}));
vi.mock("@/lib/jobs/worker-status", () => ({
  recordError: vi.fn(),
  recordWithingsSync: vi.fn(),
}));
vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (event: {
      setBackground: (value: unknown) => void;
      setError: (error: unknown) => void;
      addWarning: (warning: string) => void;
    }) => Promise<void>,
  ) =>
    fn({
      setBackground: vi.fn(),
      setError: vi.fn(),
      addWarning: vi.fn(),
    }),
}));
vi.mock("@/lib/logging/fire-and-forget", () => ({
  fireAndForget: vi.fn(),
}));
vi.mock("../reminder/shared", () => ({
  getWorkerPrisma: vi.fn(() => ({
    withingsConnection: { findMany: vi.fn(async () => []) },
  })),
}));

import {
  handleWithingsEcgSync,
  type WithingsEcgSyncPayload,
} from "../reminder/withings-sync";

function job(data: WithingsEcgSyncPayload): Job<WithingsEcgSyncPayload> {
  return { data } as Job<WithingsEcgSyncPayload>;
}

beforeEach(() => {
  vi.clearAllMocks();
});
const registrarSource = readFileSync(
  join(process.cwd(), "src/lib/jobs/reminder/register-integration-sync.ts"),
  "utf8",
);

describe("handleWithingsEcgSync", () => {
  it("rejects a failed source write so pg-boss can retry the same job", async () => {
    syncUserEcg
      .mockRejectedValueOnce(new Error("source write failed"))
      .mockResolvedValueOnce(1);
    const queued = job({
      userId: "user-1",
      eventId: "wu-1:1:1715000000:1715000060",
      triggeredAt: "2026-07-20T12:00:00.000Z",
      startdate: 1715000000,
      enddate: 1715000060,
    });

    await expect(handleWithingsEcgSync([queued])).rejects.toThrow(
      "source write failed",
    );
    await expect(handleWithingsEcgSync([queued])).resolves.toBeUndefined();

    expect(syncUserEcg).toHaveBeenCalledTimes(2);
    expect(syncUserEcg).toHaveBeenNthCalledWith(1, "user-1", {
      startdate: 1715000000,
      enddate: 1715000060,
    });
    expect(syncUserEcg).toHaveBeenNthCalledWith(2, "user-1", {
      startdate: 1715000000,
      enddate: 1715000060,
    });
  });
});

describe("withings ECG queue registration", () => {
  it("deduplicates only queued replays and admits a rescue after work starts", () => {
    const allQueues = registrarSource.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueues).not.toBeNull();
    expect(allQueues![1]).toMatch(/\bWITHINGS_ECG_SYNC_QUEUE\b/);
    expect(registrarSource).toMatch(
      /\[WITHINGS_ECG_SYNC_QUEUE\]:\s*\{[\s\S]*?policy:\s*"short"/,
    );
    expect(registrarSource).toMatch(
      /boss\.work<WithingsEcgSyncPayload>\([\s\S]*?WITHINGS_ECG_SYNC_QUEUE[\s\S]*?handleWithingsEcgSync/,
    );
  });
});
