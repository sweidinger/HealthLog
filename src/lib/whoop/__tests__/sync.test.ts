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
  recordSyncFailure: vi.fn<(...a: unknown[]) => Promise<void>>(
    async () => {},
  ),
  recordSyncSuccess: vi.fn<(...a: unknown[]) => Promise<void>>(
    async () => {},
  ),
  isReauthRequired: vi.fn<(...a: unknown[]) => Promise<boolean>>(
    async () => false,
  ),
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
  isCollectionForbidden,
  markResourceSynced,
  resolveResourceCursor,
  upsertWhoopMeasurements,
  WHOOP_DEFAULT_OVERLAP_MS,
  WHOOP_FULL_SYNC_ANCHOR,
  WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
} from "../sync";
import { WhoopApiError } from "../response-classifier";
import { syncUserRecovery } from "../sync-recovery";

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
  it("anchors a full sync at the deep-history anchor, ignoring the cursor", () => {
    const got = incrementalStart(new Date("2026-06-01T12:00:00Z"), {
      fullSync: true,
    });
    expect(got).toEqual(WHOOP_FULL_SYNC_ANCHOR);
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

  it("a fullSync reaches a span an incremental tick would skip", () => {
    // Incremental from a recent cursor only looks back the overlap (days); a
    // fullSync anchors years back, so it covers history the incremental misses.
    const recentCursor = new Date("2026-06-01T12:00:00Z");
    const incremental = incrementalStart(recentCursor, {
      overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    });
    const full = incrementalStart(recentCursor, { fullSync: true });
    const yearOld = new Date("2025-01-01T00:00:00Z");
    // A year-old record is BEFORE the incremental start (skipped) but AFTER
    // the full-sync anchor (covered).
    expect(yearOld.getTime()).toBeLessThan(incremental!.getTime());
    expect(yearOld.getTime()).toBeGreaterThan(full!.getTime());
  });
});

describe("resolveResourceCursor — per-resource cursor", () => {
  it("prefers the per-resource cursor over the shared lastSyncedAt", () => {
    const got = resolveResourceCursor(
      {
        resourceCursors: { workout: "2026-06-10T00:00:00.000Z" },
        lastSyncedAt: new Date("2026-06-12T00:00:00.000Z"),
      },
      "workout",
    );
    expect(got?.toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });

  it("falls back to lastSyncedAt for a resource with no cursor key (legacy)", () => {
    const shared = new Date("2026-06-12T00:00:00.000Z");
    const got = resolveResourceCursor(
      { resourceCursors: { recovery: "2026-06-10T00:00:00.000Z" }, lastSyncedAt: shared },
      "workout",
    );
    expect(got).toEqual(shared);
  });

  it("falls back to lastSyncedAt when the column is null", () => {
    const shared = new Date("2026-06-12T00:00:00.000Z");
    expect(
      resolveResourceCursor({ resourceCursors: null, lastSyncedAt: shared }, "sleep"),
    ).toEqual(shared);
  });

  it("a stalled resource cursor does not advance with a sibling's", () => {
    // workout last synced a week ago; recovery synced an hour ago. Resolving
    // workout must still return the OLD workout cursor — a sibling's progress
    // never drags the stalled resource's window forward.
    const connection = {
      resourceCursors: {
        recovery: "2026-06-12T11:00:00.000Z",
        workout: "2026-06-05T12:00:00.000Z",
      },
      lastSyncedAt: new Date("2026-06-12T11:00:00.000Z"),
    };
    const workoutStart = incrementalStart(
      resolveResourceCursor(connection, "workout"),
      { overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS },
    );
    // Workout still re-fetches from a week-old cursor minus the overlap, NOT
    // from recovery's recent one — the late-synced workout stays in range.
    expect(workoutStart!.getTime()).toBe(
      new Date("2026-06-05T12:00:00.000Z").getTime() -
        WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    );
  });
});

describe("markResourceSynced — independent cursor advance", () => {
  it("advances ONLY the named resource's key, preserving siblings", async () => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      resourceCursors: { recovery: "2026-06-01T00:00:00.000Z" },
    });
    prismaMock.whoopConnection.update.mockResolvedValue({});

    const at = new Date("2026-06-14T08:00:00.000Z");
    await markResourceSynced("user1", "workout", at);

    const data = prismaMock.whoopConnection.update.mock.calls[0]![0].data;
    // recovery's older cursor is preserved; workout is set to `at`.
    expect(data.resourceCursors).toEqual({
      recovery: "2026-06-01T00:00:00.000Z",
      workout: at.toISOString(),
    });
    // The shared cursor keeps moving for any legacy reader.
    expect(data.lastSyncedAt).toEqual(at);
  });

  it("seeds the map from empty when the column is null", async () => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      resourceCursors: null,
    });
    prismaMock.whoopConnection.update.mockResolvedValue({});

    const at = new Date("2026-06-14T08:00:00.000Z");
    await markResourceSynced("user1", "sleep", at);

    expect(
      prismaMock.whoopConnection.update.mock.calls[0]![0].data.resourceCursors,
    ).toEqual({ sleep: at.toISOString() });
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

describe("isCollectionForbidden — tier degradation gate", () => {
  it("is true only for a WhoopApiError carrying HTTP 403", () => {
    const forbidden = new WhoopApiError({
      verb: "fetchRecoveries",
      classification: "reauth_required",
      httpStatus: 403,
      reason: "http_403",
    });
    expect(isCollectionForbidden(forbidden)).toBe(true);
  });

  it("is false for a 401 (genuine token reject → connection-wide reauth)", () => {
    const unauthorized = new WhoopApiError({
      verb: "fetchRecoveries",
      classification: "reauth_required",
      httpStatus: 401,
      reason: "http_401",
    });
    expect(isCollectionForbidden(unauthorized)).toBe(false);
  });

  it("is false for a non-WhoopApiError", () => {
    expect(isCollectionForbidden(new Error("network down"))).toBe(false);
    expect(isCollectionForbidden("boom")).toBe(false);
  });
});

describe("per-resource 403 soft-skip vs reauth", () => {
  beforeEach(() => {
    prismaMock.whoopConnection.findUnique.mockResolvedValue({
      id: "conn1",
      whoopUserId: "42",
      accessToken: "enc(live-access)",
      refreshToken: "enc(live-refresh)",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastSyncedAt: new Date("2026-06-01T00:00:00Z"),
    });
    prismaMock.whoopConnection.update.mockResolvedValue({});
  });

  it("a collection 403 soft-skips: returns 0, records NO failure (connection stays connected)", async () => {
    fetchRecoveriesMock.mockRejectedValue(
      new WhoopApiError({
        verb: "fetchRecoveries",
        classification: "reauth_required",
        httpStatus: 403,
        reason: "http_403",
      }),
    );

    const imported = await syncUserRecovery("user1");

    expect(imported).toBe(0);
    // No failure recorded → recordSyncFailure never parks the row at
    // error_reauth, so the next syncUserWhoop does not short-circuit.
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("a collection 401 still records a reauth failure and rethrows", async () => {
    fetchRecoveriesMock.mockRejectedValue(
      new WhoopApiError({
        verb: "fetchRecoveries",
        classification: "reauth_required",
        httpStatus: 401,
        reason: "http_401",
      }),
    );

    await expect(syncUserRecovery("user1")).rejects.toThrow();
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "whoop",
        kind: "reauth_required",
      }),
    );
  });
});
