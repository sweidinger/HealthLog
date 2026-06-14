import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getConnMock,
  fetchRechargesMock,
  fetchSleepsMock,
  fetchActivitiesMock,
  upsertMock,
  recordSuccessMock,
  recordFailureMock,
  recomputeMock,
  invalidateMock,
} = vi.hoisted(() => ({
  getConnMock: vi.fn(),
  fetchRechargesMock: vi.fn(),
  fetchSleepsMock: vi.fn(),
  fetchActivitiesMock: vi.fn(),
  upsertMock: vi.fn(),
  recordSuccessMock: vi.fn(),
  recordFailureMock: vi.fn(),
  recomputeMock: vi.fn(),
  invalidateMock: vi.fn(),
}));

vi.mock("../credentials", () => ({
  getPolarConnection: getConnMock,
}));

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { upsert: upsertMock } },
}));

vi.mock("@/lib/integrations/status", () => ({
  recordSyncSuccess: recordSuccessMock,
  recordSyncFailure: recordFailureMock,
}));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: (rows: Array<{ type: string; measuredAt: Date }>) =>
    rows.map((r) => ({ type: r.type, measuredAt: r.measuredAt })),
  recomputeBucketsForMeasurement: recomputeMock,
}));

vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: invalidateMock,
}));

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return {
    ...actual,
    fetchNightlyRecharges: fetchRechargesMock,
    fetchSleeps: fetchSleepsMock,
    fetchActivities: fetchActivitiesMock,
  };
});

import { syncUserPolar } from "../sync";
import { PolarApiError } from "../response-classifier";

const CONN = { accessToken: "tok", polarUserId: "42" };

beforeEach(() => {
  getConnMock.mockReset();
  fetchRechargesMock.mockReset();
  fetchSleepsMock.mockReset();
  fetchActivitiesMock.mockReset();
  upsertMock.mockReset().mockResolvedValue({});
  recordSuccessMock.mockReset().mockResolvedValue(undefined);
  recordFailureMock.mockReset().mockResolvedValue(undefined);
  recomputeMock.mockReset().mockResolvedValue(undefined);
  invalidateMock.mockReset().mockResolvedValue(undefined);
  fetchRechargesMock.mockResolvedValue([]);
  fetchSleepsMock.mockResolvedValue([]);
  fetchActivitiesMock.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe("syncUserPolar", () => {
  it("no-ops cleanly for an unconnected user", async () => {
    getConnMock.mockResolvedValue(null);
    expect(await syncUserPolar("u1")).toBe(0);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("maps a recharge RECOVERY_SCORE row with source POLAR + stable externalId", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchRechargesMock.mockResolvedValue([
      { date: "2026-06-10", nightly_recharge_status: 6 },
    ]);
    const imported = await syncUserPolar("u1");
    expect(imported).toBe(1);
    const arg = upsertMock.mock.calls[0]![0];
    expect(arg.where.userId_type_source_externalId).toMatchObject({
      userId: "u1",
      type: "RECOVERY_SCORE",
      source: "POLAR",
      externalId: "recharge:2026-06-10:recovery",
    });
    expect(arg.create.source).toBe("POLAR");
    expect(arg.create.value).toBe(100);
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "polar");
  });

  it("is idempotent — a re-sync upserts on the same externalId", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchRechargesMock.mockResolvedValue([
      { date: "2026-06-10", nightly_recharge_status: 3 },
    ]);
    await syncUserPolar("u1");
    await syncUserPolar("u1");
    expect(upsertMock.mock.calls[0]![0].where).toEqual(
      upsertMock.mock.calls[1]![0].where,
    );
  });

  it("records a reauth_required failure on a 401 and rethrows", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchRechargesMock.mockRejectedValue(
      new PolarApiError({
        verb: "fetchNightlyRecharges",
        classification: "reauth_required",
        httpStatus: 401,
        reason: "http_401",
      }),
    );
    await expect(syncUserPolar("u1")).rejects.toBeInstanceOf(PolarApiError);
    expect(recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        integration: "polar",
        kind: "reauth_required",
        errorCode: "401",
      }),
    );
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });
});
