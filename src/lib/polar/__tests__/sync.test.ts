import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getConnMock,
  fetchRechargesMock,
  fetchSleepsMock,
  fetchActivitiesMock,
  fetchCardioLoadsMock,
  fetchSpo2Mock,
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
  fetchCardioLoadsMock: vi.fn(),
  fetchSpo2Mock: vi.fn(),
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

vi.mock("@/lib/integrations/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/status")>()),
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
    fetchCardioLoads: fetchCardioLoadsMock,
    fetchSpo2: fetchSpo2Mock,
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
  fetchCardioLoadsMock.mockReset();
  fetchSpo2Mock.mockReset();
  upsertMock.mockReset().mockResolvedValue({});
  recordSuccessMock.mockReset().mockResolvedValue(undefined);
  recordFailureMock.mockReset().mockResolvedValue(undefined);
  recomputeMock.mockReset().mockResolvedValue(undefined);
  invalidateMock.mockReset().mockResolvedValue(undefined);
  fetchRechargesMock.mockResolvedValue([]);
  fetchSleepsMock.mockResolvedValue([]);
  fetchActivitiesMock.mockResolvedValue([]);
  fetchCardioLoadsMock.mockResolvedValue([]);
  fetchSpo2Mock.mockResolvedValue([]);
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

  it("maps a cardio-load row with source POLAR + stable externalId", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchCardioLoadsMock.mockResolvedValue([
      { date: "2026-06-10", cardio_load: 123.45 },
    ]);
    const imported = await syncUserPolar("u1");
    expect(imported).toBe(1);
    const arg = upsertMock.mock.calls[0]![0];
    expect(arg.where.userId_type_source_externalId).toMatchObject({
      type: "CARDIO_LOAD",
      source: "POLAR",
      externalId: "cardioload:2026-06-10:cardio_load",
    });
    expect(arg.create.value).toBe(123.45);
  });

  it("keeps reconstructed sleep segments distinct under their indexed externalId", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchSleepsMock.mockResolvedValue([
      {
        date: "2026-06-10",
        sleep_start_time: "2026-06-09T23:00:00+02:00",
        sleep_end_time: "2026-06-10T07:00:00+02:00",
        light_sleep: 3600,
        deep_sleep: 1800,
        rem_sleep: 5400,
      },
    ]);
    await syncUserPolar("u1");
    const externalIds = upsertMock.mock.calls.map(
      (c) => c[0].where.userId_type_source_externalId.externalId,
    );
    expect(externalIds).toContain("sleep:2026-06-10:seg:sleep_core:0");
    expect(externalIds).toContain("sleep:2026-06-10:seg:sleep_rem:2");
    // The several segment rows stay distinct (no collision).
    expect(new Set(externalIds).size).toBe(externalIds.length);
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
