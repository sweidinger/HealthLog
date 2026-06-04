/**
 * v1.12.0 — Fitbit token-management tests (mocked). Covers `getValidToken`:
 *   - the NO-ROTATION refresh branch (refresh token preserved when the response
 *     omits it; overwritten only when a fresh one is returned);
 *   - the stored-token fast path when not near expiry;
 *   - a reauth failure recorded when credentials are missing on refresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, refreshAccessTokenMock, recordSyncFailure } = vi.hoisted(
  () => ({
    prismaMock: {
      fitbitConnection: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      measurement: {
        upsert: vi.fn<(arg: Record<string, unknown>) => Promise<unknown>>(
          async () => ({}),
        ),
      },
    },
    refreshAccessTokenMock: vi.fn(),
    recordSyncFailure: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  }),
);

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: () => [],
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
}));

vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(|\)$/g, ""),
}));

vi.mock("../client", async (orig) => {
  const actual = await orig<typeof import("../client")>();
  return {
    ...actual,
    refreshAccessToken: (...a: unknown[]) => refreshAccessTokenMock(...a),
  };
});

vi.mock("../credentials", () => ({
  getUserFitbitCredentials: vi.fn(async () => ({
    clientId: "cid",
    clientSecret: "csecret",
  })),
}));

vi.mock("@/lib/integrations/status", () => ({
  recordSyncFailure: (...a: unknown[]) => recordSyncFailure(...a),
}));

import {
  classificationToFailureKind,
  getValidToken,
  upsertFitbitMeasurements,
} from "../sync";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getValidToken — non-rotating refresh", () => {
  it("persists the new access token and KEEPS the stored refresh token when the response omits one", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue({
      id: "conn1",
      fitbitUserId: "abc123",
      accessToken: "enc(old-access)",
      refreshToken: "enc(old-refresh)",
      // Expired so the refresh path fires.
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    // Google does NOT return a refresh_token on a routine refresh.
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-access",
      expires_in: 3600,
    });
    prismaMock.fitbitConnection.update.mockResolvedValue({});

    const result = await getValidToken("user1");

    expect(result?.accessToken).toBe("new-access");
    expect(refreshAccessTokenMock).toHaveBeenCalledWith("old-refresh", {
      clientId: "cid",
      clientSecret: "csecret",
    });
    const updateArg = prismaMock.fitbitConnection.update.mock.calls[0]![0];
    expect(updateArg.data.accessToken).toBe("enc(new-access)");
    // The stored refresh token must NOT be touched when the response omits one.
    expect(updateArg.data).not.toHaveProperty("refreshToken");
  });

  it("overwrites the stored refresh token only when the response carries a fresh one", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue({
      id: "conn1",
      fitbitUserId: "abc123",
      accessToken: "enc(old-access)",
      refreshToken: "enc(old-refresh)",
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
    prismaMock.fitbitConnection.update.mockResolvedValue({});

    await getValidToken("user1");

    const updateArg = prismaMock.fitbitConnection.update.mock.calls[0]![0];
    expect(updateArg.data.accessToken).toBe("enc(new-access)");
    expect(updateArg.data.refreshToken).toBe("enc(rotated-refresh)");
  });

  it("returns the stored token without refresh when not near expiry", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue({
      id: "conn1",
      fitbitUserId: "abc123",
      accessToken: "enc(live-access)",
      refreshToken: "enc(live-refresh)",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await getValidToken("user1");

    expect(result?.accessToken).toBe("live-access");
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(prismaMock.fitbitConnection.update).not.toHaveBeenCalled();
  });

  it("returns null when there is no connection", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue(null);
    expect(await getValidToken("user1")).toBeNull();
  });

  it("records a reauth failure when credentials are missing on refresh", async () => {
    const { getUserFitbitCredentials } = await import("../credentials");
    (
      getUserFitbitCredentials as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(null);
    prismaMock.fitbitConnection.findUnique.mockResolvedValue({
      id: "conn1",
      fitbitUserId: "abc123",
      accessToken: "enc(a)",
      refreshToken: "enc(r)",
      tokenExpiresAt: new Date(Date.now() - 1000),
    });

    const result = await getValidToken("user1");

    expect(result).toBeNull();
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "fitbit",
        kind: "reauth_required",
      }),
    );
  });

  it("records a classified failure and returns null when the refresh itself fails", async () => {
    prismaMock.fitbitConnection.findUnique.mockResolvedValue({
      id: "conn1",
      fitbitUserId: "abc123",
      accessToken: "enc(a)",
      refreshToken: "enc(r)",
      tokenExpiresAt: new Date(Date.now() - 1000),
    });
    refreshAccessTokenMock.mockRejectedValue(
      new Error("Fitbit refreshAccessToken error: 401"),
    );

    const result = await getValidToken("user1");

    expect(result).toBeNull();
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "fitbit",
        kind: "reauth_required",
      }),
    );
  });
});

describe("upsertFitbitMeasurements — idempotent FITBIT upsert", () => {
  it("upserts each reading on the (userId, type, source=FITBIT, externalId) key with field-by-field data", async () => {
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    const imported = await upsertFitbitMeasurements("user1", [
      {
        type: "WEIGHT",
        value: 80.5,
        unit: "kg",
        measuredAt,
        externalId: "2026-05-10T07:00:00.000Z:weight",
      },
    ]);

    expect(imported).toBe(1);
    const arg = prismaMock.measurement.upsert.mock.calls[0]![0] as {
      where: { userId_type_source_externalId: Record<string, unknown> };
      create: Record<string, unknown>;
      update: { syncVersion: unknown };
    };
    // The composite unique key pins source = FITBIT — a re-post overwrites in
    // place rather than minting a duplicate.
    expect(arg.where.userId_type_source_externalId).toEqual({
      userId: "user1",
      type: "WEIGHT",
      source: "FITBIT",
      externalId: "2026-05-10T07:00:00.000Z:weight",
    });
    // create builds the data field-by-field (no mass-assignment spread).
    expect(arg.create).toMatchObject({
      userId: "user1",
      type: "WEIGHT",
      source: "FITBIT",
      value: 80.5,
      unit: "kg",
    });
    // update bumps syncVersion for the iOS LWW reconciler.
    expect(arg.update.syncVersion).toEqual({ increment: 1 });
  });

  it("returns 0 without touching prisma for an empty batch", async () => {
    const imported = await upsertFitbitMeasurements("user1", []);
    expect(imported).toBe(0);
    expect(prismaMock.measurement.upsert).not.toHaveBeenCalled();
  });
});

describe("classificationToFailureKind", () => {
  it("maps each classification onto a FailureKind", () => {
    expect(classificationToFailureKind("reauth_required")).toBe(
      "reauth_required",
    );
    expect(classificationToFailureKind("persistent")).toBe("persistent");
    expect(classificationToFailureKind("transient")).toBe("transient");
    // A success has no failure kind; surface it as transient (contract-bug
    // anomaly is still recorded).
    expect(classificationToFailureKind("success")).toBe("transient");
  });
});
