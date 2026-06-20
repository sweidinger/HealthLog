import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getConnMock,
  storeTokensMock,
  getCredsMock,
  fetchReadinessMock,
  fetchSleepMock,
  fetchActivityMock,
  fetchDailySleepMock,
  fetchSpo2Mock,
  fetchVo2MaxMock,
  refreshMock,
  upsertMock,
  recordSuccessMock,
  recordFailureMock,
  recomputeMock,
  invalidateMock,
} = vi.hoisted(() => ({
  getConnMock: vi.fn(),
  storeTokensMock: vi.fn(),
  getCredsMock: vi.fn(),
  fetchReadinessMock: vi.fn(),
  fetchSleepMock: vi.fn(),
  fetchActivityMock: vi.fn(),
  fetchDailySleepMock: vi.fn(),
  fetchSpo2Mock: vi.fn(),
  fetchVo2MaxMock: vi.fn(),
  refreshMock: vi.fn(),
  upsertMock: vi.fn(),
  recordSuccessMock: vi.fn(),
  recordFailureMock: vi.fn(),
  recomputeMock: vi.fn(),
  invalidateMock: vi.fn(),
}));

vi.mock("../credentials", () => ({
  getOuraConnection: getConnMock,
  storeOuraTokens: storeTokensMock,
  getOuraClientCredentials: getCredsMock,
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
    fetchReadiness: fetchReadinessMock,
    fetchSleep: fetchSleepMock,
    fetchDailyActivity: fetchActivityMock,
    fetchDailySleep: fetchDailySleepMock,
    fetchDailySpo2: fetchSpo2Mock,
    fetchVo2Max: fetchVo2MaxMock,
    refreshAccessToken: refreshMock,
  };
});

import { syncUserOura } from "../sync";
import { OuraApiError } from "../response-classifier";

const CONN = { accessToken: "acc", refreshToken: "ref" };

beforeEach(() => {
  getConnMock.mockReset();
  storeTokensMock.mockReset().mockResolvedValue(undefined);
  getCredsMock
    .mockReset()
    .mockResolvedValue({ clientId: "c", clientSecret: "s" });
  fetchReadinessMock.mockReset().mockResolvedValue([]);
  fetchSleepMock.mockReset().mockResolvedValue([]);
  fetchActivityMock.mockReset().mockResolvedValue([]);
  fetchDailySleepMock.mockReset().mockResolvedValue([]);
  fetchSpo2Mock.mockReset().mockResolvedValue([]);
  fetchVo2MaxMock.mockReset().mockResolvedValue([]);
  refreshMock.mockReset();
  upsertMock.mockReset().mockResolvedValue({});
  recordSuccessMock.mockReset().mockResolvedValue(undefined);
  recordFailureMock.mockReset().mockResolvedValue(undefined);
  recomputeMock.mockReset().mockResolvedValue(undefined);
  invalidateMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

function err401() {
  return new OuraApiError({
    verb: "fetchReadiness",
    classification: "reauth_required",
    httpStatus: 401,
    reason: "http_401",
  });
}

describe("syncUserOura", () => {
  it("no-ops cleanly when unconnected", async () => {
    getConnMock.mockResolvedValue(null);
    expect(await syncUserOura("u1")).toBe(0);
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("writes a readiness RECOVERY_SCORE with source OURA", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchReadinessMock.mockResolvedValue([
      { id: "x", day: "2026-06-10", score: 84 },
    ]);
    const imported = await syncUserOura("u1");
    expect(imported).toBe(1);
    const arg = upsertMock.mock.calls[0]![0];
    expect(arg.where.userId_type_source_externalId).toMatchObject({
      type: "RECOVERY_SCORE",
      source: "OURA",
      externalId: "readiness:2026-06-10:recovery",
    });
    expect(arg.create.value).toBe(84);
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "oura");
  });

  it("refreshes the token on a 401 and retries once", async () => {
    getConnMock.mockResolvedValue(CONN);
    // First call (with old token) 401s; after refresh the retry succeeds.
    fetchReadinessMock
      .mockRejectedValueOnce(err401())
      .mockResolvedValueOnce([{ id: "x", day: "2026-06-10", score: 70 }]);
    refreshMock.mockResolvedValue({
      access_token: "newAcc",
      refresh_token: "newRef",
      expires_in: 86400,
    });
    const imported = await syncUserOura("u1");
    expect(refreshMock).toHaveBeenCalledWith("ref", expect.anything());
    expect(storeTokensMock).toHaveBeenCalledWith("u1", "newAcc", "newRef");
    expect(imported).toBe(1);
    expect(recordSuccessMock).toHaveBeenCalledWith("u1", "oura");
  });

  it("records reauth_required when the refresh itself fails", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchReadinessMock.mockRejectedValue(err401());
    refreshMock.mockRejectedValue(
      new OuraApiError({
        verb: "refreshAccessToken",
        classification: "reauth_required",
        httpStatus: 400,
        reason: "http_400",
        upstreamError: "invalid_grant",
      }),
    );
    await expect(syncUserOura("u1")).rejects.toBeInstanceOf(OuraApiError);
    expect(recordFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ integration: "oura", kind: "reauth_required" }),
    );
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("keeps a nap and the main sleep distinct via record-scoped externalIds (B2)", async () => {
    getConnMock.mockResolvedValue(CONN);
    // Two sleep records on the same day: a main sleep + a nap.
    fetchSleepMock.mockResolvedValue([
      { id: "main", day: "2026-06-10", deep_sleep_duration: 3600 },
      { id: "nap", day: "2026-06-10", deep_sleep_duration: 1200 },
    ]);
    await syncUserOura("u1");
    const externalIds = upsertMock.mock.calls.map(
      (c) => c[0].where.userId_type_source_externalId.externalId,
    );
    expect(externalIds).toContain("sleep:main:sleep_deep");
    expect(externalIds).toContain("sleep:nap:sleep_deep");
    // The legacy day-keyed collapse would have produced one shared key.
    expect(new Set(externalIds).size).toBe(externalIds.length);
  });

  it("writes the Sleep Score and SpO2 from the new collections", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchDailySleepMock.mockResolvedValue([
      { id: "s", day: "2026-06-10", score: 80 },
    ]);
    fetchSpo2Mock.mockResolvedValue([
      { id: "o", day: "2026-06-10", spo2_percentage: { average: 97 } },
    ]);
    await syncUserOura("u1");
    const written = upsertMock.mock.calls.map((c) => ({
      type: c[0].where.userId_type_source_externalId.type,
      externalId: c[0].where.userId_type_source_externalId.externalId,
      value: c[0].create.value,
    }));
    expect(written).toContainEqual({
      type: "SLEEP_SCORE",
      externalId: "daily_sleep:2026-06-10:sleep_score",
      value: 80,
    });
    expect(written).toContainEqual({
      type: "OXYGEN_SATURATION",
      externalId: "spo2:2026-06-10:spo2",
      value: 97,
    });
  });

  it("writes VO2_MAX from the dedicated collection", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchVo2MaxMock.mockResolvedValue([
      { id: "v", day: "2026-06-10", vo2_max: 47.3 },
    ]);
    await syncUserOura("u1");
    const written = upsertMock.mock.calls.map((c) => ({
      type: c[0].where.userId_type_source_externalId.type,
      externalId: c[0].where.userId_type_source_externalId.externalId,
      value: c[0].create.value,
    }));
    expect(written).toContainEqual({
      type: "VO2_MAX",
      externalId: "vo2max:2026-06-10:vo2_max",
      value: 47.3,
    });
    // daily_stress → STRESS_SCORE is withdrawn pending ladder wiring.
    expect(written.some((w) => w.type === "STRESS_SCORE")).toBe(false);
  });

  it("does NOT refresh on a 403 (not an expiry case)", async () => {
    getConnMock.mockResolvedValue(CONN);
    fetchReadinessMock.mockRejectedValue(
      new OuraApiError({
        verb: "fetchReadiness",
        classification: "reauth_required",
        httpStatus: 403,
        reason: "http_403",
      }),
    );
    await expect(syncUserOura("u1")).rejects.toBeInstanceOf(OuraApiError);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
