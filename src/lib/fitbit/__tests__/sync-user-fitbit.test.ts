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
} = vi.hoisted(() => ({
  recordSyncSuccess: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  recordSyncFailure: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  isReauthRequired: vi.fn<(...a: unknown[]) => Promise<boolean>>(
    async () => false,
  ),
  syncUserMetrics: vi.fn<(...a: unknown[]) => Promise<number>>(),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
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

beforeEach(() => {
  vi.clearAllMocks();
  isReauthRequired.mockResolvedValue(false);
});

describe("syncUserFitbit — all-403 looks-healthy guard", () => {
  it("does NOT stamp success when the resource soft-skipped and nothing imported", async () => {
    syncUserMetrics.mockImplementation(softSkip403);

    const total = await syncUserFitbit("user1");

    expect(total).toBe(0);
    expect(recordSyncSuccess).not.toHaveBeenCalled();
    // Soft-skips record no failure either — the status is left exactly as-is so
    // the token-refresh 401 path is the one that flips it to reauth.
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("stamps success on a cycle that imported rows", async () => {
    syncUserMetrics.mockResolvedValue(5);

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
  });
});
