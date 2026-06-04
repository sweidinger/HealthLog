/**
 * v1.12.0 — `syncUserFitbit` orchestration tests (mocked resource sync).
 *
 * Covers the all-403 "looks-healthy" guard: a genuine grant-revoke 403s the
 * metrics collection. The resource sync soft-skips (returns 0, records no
 * failure) via `handleCollectionFetchError`, so the orchestrator sees
 * `total === 0` with no thrown error — and without the guard would stamp
 * `recordSyncSuccess`, keeping a dead connection "connected" until the
 * token-refresh path catches the 401. The guard refuses to stamp success when
 * every enabled resource soft-skipped and nothing imported.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  recordSyncSuccess,
  recordSyncFailure,
  isReauthRequired,
  syncUserMetrics,
  syncUserActivity,
  syncUserSleep,
  syncUserWorkout,
  findUnique,
  update,
} = vi.hoisted(() => ({
  recordSyncSuccess: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  recordSyncFailure: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  isReauthRequired: vi.fn<(...a: unknown[]) => Promise<boolean>>(
    async () => false,
  ),
  syncUserMetrics: vi.fn<(...a: unknown[]) => Promise<number>>(),
  syncUserActivity: vi.fn<(...a: unknown[]) => Promise<number>>(),
  syncUserSleep: vi.fn<(...a: unknown[]) => Promise<number>>(),
  syncUserWorkout: vi.fn<(...a: unknown[]) => Promise<number>>(),
  findUnique: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  update: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({})),
}));

vi.mock("@/lib/db", () => ({
  prisma: { fitbitConnection: { findUnique, update } },
}));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => null,
  annotate: () => {},
}));
vi.mock("@/lib/integrations/status", () => ({
  recordSyncFailure: (...a: unknown[]) => recordSyncFailure(...a),
  recordSyncSuccess: (...a: unknown[]) => recordSyncSuccess(...a),
  isReauthRequired: (...a: unknown[]) => isReauthRequired(...a),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: () => [],
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));

vi.mock("../sync-metrics", () => ({
  syncUserMetrics: (...a: unknown[]) => syncUserMetrics(...a),
}));
vi.mock("../sync-activity", () => ({
  syncUserActivity: (...a: unknown[]) => syncUserActivity(...a),
}));
vi.mock("../sync-sleep", () => ({
  syncUserSleep: (...a: unknown[]) => syncUserSleep(...a),
}));
vi.mock("../sync-workout", () => ({
  syncUserWorkout: (...a: unknown[]) => syncUserWorkout(...a),
}));

import { handleCollectionFetchError, syncUserFitbit } from "../sync";
import { FitbitApiError } from "../response-classifier";

/** A resource sync that 403s its collection and soft-skips, like the real one. */
async function softSkip403(...args: unknown[]): Promise<number> {
  return handleCollectionFetchError(
    "test-resource",
    String(args[0]),
    new FitbitApiError({
      verb: "fetchTest",
      classification: "reauth_required",
      httpStatus: 403,
      reason: "http_403",
    }),
  );
}

/** A connection with a fixed last-synced watermark for the snapshot tests. */
const LAST_SYNCED = new Date("2026-06-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  isReauthRequired.mockResolvedValue(false);
  // Default: a connected account with a known watermark.
  findUnique.mockResolvedValue({ lastSyncedAt: LAST_SYNCED });
  update.mockResolvedValue({});
  // The W5 resources default to a quiet success (nothing new) so a test that
  // exercises only the metrics resource doesn't trip the all-soft-skipped guard.
  syncUserMetrics.mockResolvedValue(0);
  syncUserActivity.mockResolvedValue(0);
  syncUserSleep.mockResolvedValue(0);
  syncUserWorkout.mockResolvedValue(0);
});

describe("syncUserFitbit — all-403 looks-healthy guard", () => {
  it("does NOT stamp success when EVERY resource soft-skipped and nothing imported", async () => {
    // A genuine grant-revoke 403s every Restricted bundle — each resource
    // soft-skips. Only when ALL of them soft-skip and nothing imported does the
    // guard refuse to stamp success.
    syncUserMetrics.mockImplementation(softSkip403);
    syncUserActivity.mockImplementation(softSkip403);
    syncUserSleep.mockImplementation(softSkip403);
    syncUserWorkout.mockImplementation(softSkip403);

    const total = await syncUserFitbit("user1");

    expect(total).toBe(0);
    expect(recordSyncSuccess).not.toHaveBeenCalled();
    // Soft-skips record no failure either — the status is left exactly as-is so
    // the token-refresh 401 path is the one that flips it to reauth.
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("stamps success when at least one resource synced even though others soft-skip", async () => {
    // A partial grant: metrics imports, the rest 403 (bundles not granted).
    syncUserMetrics.mockResolvedValue(5);
    syncUserActivity.mockImplementation(softSkip403);
    syncUserSleep.mockImplementation(softSkip403);
    syncUserWorkout.mockImplementation(softSkip403);

    const total = await syncUserFitbit("user1");

    expect(total).toBe(5);
    expect(recordSyncSuccess).toHaveBeenCalledWith("user1", "fitbit");
  });

  it("stamps success on a cycle that imported rows", async () => {
    syncUserMetrics.mockResolvedValue(3);
    syncUserActivity.mockResolvedValue(2);

    const total = await syncUserFitbit("user1");

    expect(total).toBe(5);
    expect(recordSyncSuccess).toHaveBeenCalledWith("user1", "fitbit");
  });

  it("stamps success on a quiet cycle (no soft-skip, nothing new)", async () => {
    syncUserMetrics.mockResolvedValue(0);

    const total = await syncUserFitbit("user1");

    expect(total).toBe(0);
    // No collection was 403'd → this is a genuine "nothing changed" tick.
    expect(recordSyncSuccess).toHaveBeenCalledWith("user1", "fitbit");
  });

  it("short-circuits without stamping success when parked at error_reauth", async () => {
    isReauthRequired.mockResolvedValue(true);

    const total = await syncUserFitbit("user1");

    expect(total).toBe(0);
    expect(recordSyncSuccess).not.toHaveBeenCalled();
    expect(syncUserMetrics).not.toHaveBeenCalled();
    // No connection read either — the reauth gate runs first.
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("syncUserFitbit — single cycle-wide watermark", () => {
  it("snapshots the incremental start ONCE and threads the SAME watermark to every resource", async () => {
    syncUserMetrics.mockResolvedValue(1);

    await syncUserFitbit("user1");

    // The connection's `lastSyncedAt` is read exactly once for the whole cycle.
    expect(findUnique).toHaveBeenCalledTimes(1);

    // Every resource receives the identical resolved `start` (lastSyncedAt - 24h
    // overlap). A per-resource read+stamp would have given later resources a
    // start of ~now, dropping the gap after an outage longer than the overlap.
    const expectedStart = new Date(
      LAST_SYNCED.getTime() - 24 * 60 * 60 * 1000,
    );
    for (const fn of [
      syncUserMetrics,
      syncUserActivity,
      syncUserSleep,
      syncUserWorkout,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
      const opts = fn.mock.calls[0]![1] as { start?: Date; fullSync?: boolean };
      expect(opts.start?.getTime()).toBe(expectedStart.getTime());
    }
  });

  it("stamps markSynced exactly ONCE at the end of a non-degenerate cycle", async () => {
    syncUserMetrics.mockResolvedValue(3);

    await syncUserFitbit("user1");

    // The single end-of-cycle stamp — never per resource.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({
      where: { userId: "user1" },
    });
  });

  it("does NOT stamp markSynced when every resource soft-skipped (all-403)", async () => {
    syncUserMetrics.mockImplementation(softSkip403);
    syncUserActivity.mockImplementation(softSkip403);
    syncUserSleep.mockImplementation(softSkip403);
    syncUserWorkout.mockImplementation(softSkip403);

    await syncUserFitbit("user1");

    // Leaving the watermark untouched on a dead cycle keeps the next tick's
    // window from silently advancing past the gap.
    expect(update).not.toHaveBeenCalled();
    expect(recordSyncSuccess).not.toHaveBeenCalled();
  });

  it("passes fullSync through with an undefined start on a backfill cycle", async () => {
    syncUserMetrics.mockResolvedValue(2);

    await syncUserFitbit("user1", { fullSync: true });

    const opts = syncUserMetrics.mock.calls[0]![1] as {
      start?: Date;
      fullSync?: boolean;
    };
    expect(opts.fullSync).toBe(true);
    // Full sync walks deep history with no lower bound.
    expect(opts.start).toBeUndefined();
  });

  it("returns 0 without running resources when the connection is gone", async () => {
    findUnique.mockResolvedValue(null);

    const total = await syncUserFitbit("user1");

    expect(total).toBe(0);
    expect(syncUserMetrics).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
