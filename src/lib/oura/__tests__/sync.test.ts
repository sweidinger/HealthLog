import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getConnMock,
  storeTokensMock,
  getCredsMock,
  fetchReadinessMock,
  fetchSleepMock,
  fetchActivityMock,
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
    getOuraCredentials: getCredsMock,
    fetchReadiness: fetchReadinessMock,
    fetchSleep: fetchSleepMock,
    fetchDailyActivity: fetchActivityMock,
    refreshAccessToken: refreshMock,
  };
});

import { syncUserOura } from "../sync";
import { OuraApiError } from "../response-classifier";

const CONN = { accessToken: "acc", refreshToken: "ref" };

beforeEach(() => {
  getConnMock.mockReset();
  storeTokensMock.mockReset().mockResolvedValue(undefined);
  getCredsMock.mockReset().mockReturnValue({ clientId: "c", clientSecret: "s" });
  fetchReadinessMock.mockReset().mockResolvedValue([]);
  fetchSleepMock.mockReset().mockResolvedValue([]);
  fetchActivityMock.mockReset().mockResolvedValue([]);
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
