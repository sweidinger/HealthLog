/**
 * v1.11.0 — WHOOP sync layer tests (mocked). Covers:
 *   - the rotating refresh token persists BOTH new tokens;
 *   - an incremental recovery sync maps + upserts idempotently (a re-post with
 *     the same externalId routes through the upsert key, never a duplicate);
 *   - the incremental window helper picks the right overlap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ────────────────────────────────────────────────
const {
  prismaMock,
  refreshAccessTokenMock,
  fetchRecoveriesMock,
  recordSyncFailure,
  recordSyncSuccess,
  isReauthRequired,
} = vi.hoisted(() => ({
  prismaMock: {
    whoopConnection: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    measurement: {
      upsert: vi.fn(),
    },
  },
  refreshAccessTokenMock: vi.fn(),
  fetchRecoveriesMock: vi.fn(),
  recordSyncFailure: vi.fn(async () => {}),
  recordSyncSuccess: vi.fn(async () => {}),
  isReauthRequired: vi.fn(async () => false),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(|\)$/g, ""),
}));

vi.mock("../client", async (orig) => {
  const actual = await orig<typeof import("../client")>();
  return {
    ...actual,
    refreshAccessToken: (...a: unknown[]) => refreshAccessTokenMock(...a),
    fetchRecoveries: (...a: unknown[]) => fetchRecoveriesMock(...a),
  };
});

vi.mock("../credentials", () => ({
  getUserWhoopCredentials: vi.fn(async () => ({
    clientId: "cid",
    clientSecret: "csecret",
  })),
}));

vi.mock("@/lib/integrations/status", () => ({
  recordSyncFailure: (...a: unknown[]) => recordSyncFailure(...a),
  recordSyncSuccess: (...a: unknown[]) => recordSyncSuccess(...a),
  isReauthRequired: (...a: unknown[]) => isReauthRequired(...a),
}));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: (
    rows: Array<{ type: string; measuredAt: Date }>,
  ) => rows.map((r) => ({ type: r.type, measuredAt: r.measuredAt })),
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
}));

vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => null,
  annotate: () => {},
}));

import {
  getValidToken,
  incrementalStart,
  upsertWhoopMeasurements,
  WHOOP_DEFAULT_OVERLAP_MS,
  WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
} from "../sync";

beforeEach(() => {
  vi.clearAllMocks();
  isReauthRequired.mockResolvedValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getValidToken — rotating refresh", () => {
  it("persists BOTH the new access AND refresh token on refresh", async () => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      id: "conn1",
      whoopUserId: "42",
      accessToken: "enc(old-access)",
      refreshToken: "enc(old-refresh)",
      // Expired (past) so the refresh path fires.
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    });
    prismaMock.whoopConnection.update.mockResolvedValue({});

    const result = await getValidToken("user1");

    expect(result?.accessToken).toBe("new-access");
    expect(refreshAccessTokenMock).toHaveBeenCalledWith("old-refresh", {
      clientId: "cid",
      clientSecret: "csecret",
    });
    const updateArg = prismaMock.whoopConnection.update.mock.calls[0]![0];
    expect(updateArg.data.accessToken).toBe("enc(new-access)");
    expect(updateArg.data.refreshToken).toBe("enc(new-refresh)");
  });

  it("returns the stored token without refresh when not near expiry", async () => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      id: "conn1",
      whoopUserId: "42",
      accessToken: "enc(live-access)",
      refreshToken: "enc(live-refresh)",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await getValidToken("user1");

    expect(result?.accessToken).toBe("live-access");
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(prismaMock.whoopConnection.update).not.toHaveBeenCalled();
  });

  it("records a reauth failure when credentials are missing on refresh", async () => {
    const { getUserWhoopCredentials } = await import("../credentials");
    (getUserWhoopCredentials as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      null,
    );
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      id: "conn1",
      whoopUserId: "42",
      accessToken: "enc(a)",
      refreshToken: "enc(r)",
      tokenExpiresAt: new Date(Date.now() - 1000),
    });

    const result = await getValidToken("user1");

    expect(result).toBeNull();
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({ integration: "whoop", kind: "reauth_required" }),
    );
  });
});

describe("incrementalStart", () => {
  it("returns undefined for a full sync", () => {
    expect(incrementalStart(new Date(), { fullSync: true })).toBeUndefined();
  });

  it("subtracts the overlap from lastSyncedAt", () => {
    const last = new Date("2026-06-01T12:00:00Z");
    const got = incrementalStart(last, {
      overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    });
    expect(got!.getTime()).toBe(
      last.getTime() - WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    );
  });

  it("defaults to the 1 h overlap when none supplied", () => {
    const last = new Date("2026-06-01T12:00:00Z");
    const got = incrementalStart(last);
    expect(got!.getTime()).toBe(last.getTime() - WHOOP_DEFAULT_OVERLAP_MS);
  });
});

describe("upsertWhoopMeasurements — idempotent upsert", () => {
  it("routes each reading through the (userId,type,source,externalId) key", async () => {
    prismaMock.measurement.upsert.mockResolvedValue({});

    const n = await upsertWhoopMeasurements("user1", [
      {
        type: "RECOVERY_SCORE",
        value: 71,
        unit: "score",
        measuredAt: new Date("2026-06-01T08:00:00Z"),
        externalId: "sleep-uuid:recovery",
      },
      {
        type: "HRV_RMSSD",
        value: 64,
        unit: "ms",
        measuredAt: new Date("2026-06-01T08:00:00Z"),
        externalId: "sleep-uuid:hrv_rmssd",
      },
    ]);

    expect(n).toBe(2);
    const firstWhere =
      prismaMock.measurement.upsert.mock.calls[0]![0].where
        .userId_type_source_externalId;
    expect(firstWhere).toEqual({
      userId: "user1",
      type: "RECOVERY_SCORE",
      source: "WHOOP",
      externalId: "sleep-uuid:recovery",
    });
  });

  it("a re-post with the same externalId is one upsert, not two rows", async () => {
    prismaMock.measurement.upsert.mockResolvedValue({});
    const reading = {
      type: "RECOVERY_SCORE",
      value: 60,
      unit: "score",
      measuredAt: new Date("2026-06-01T08:00:00Z"),
      externalId: "sleep-uuid:recovery",
    };

    await upsertWhoopMeasurements("user1", [reading]);
    await upsertWhoopMeasurements("user1", [{ ...reading, value: 75 }]);

    // Two upsert calls, both against the SAME key — the DB collapses them.
    expect(prismaMock.measurement.upsert).toHaveBeenCalledTimes(2);
    const a =
      prismaMock.measurement.upsert.mock.calls[0]![0].where
        .userId_type_source_externalId;
    const b =
      prismaMock.measurement.upsert.mock.calls[1]![0].where
        .userId_type_source_externalId;
    expect(a).toEqual(b);
  });
});
