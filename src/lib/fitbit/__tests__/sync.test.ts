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
        findMany: vi.fn<(arg: Record<string, unknown>) => Promise<unknown[]>>(
          async () => [],
        ),
        createMany: vi.fn<
          (arg: Record<string, unknown>) => Promise<{ count: number }>
        >(async (arg) => ({
          count: (arg.data as unknown[]).length,
        })),
        update: vi.fn<(arg: Record<string, unknown>) => Promise<unknown>>(
          async () => ({}),
        ),
      },
    },
    refreshAccessTokenMock: vi.fn(),
    recordSyncFailure: vi.fn<(...a: unknown[]) => Promise<void>>(
      async () => {},
    ),
  }),
);

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: (rows: Array<{ type: string; measuredAt: Date }>) =>
    rows,
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  recomputeUserRollups: vi.fn(async () => ({ rowsUpserted: 0, durationMs: 0 })),
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

describe("upsertFitbitMeasurements — batched, tombstone-safe write", () => {
  it("inserts a fresh reading via createMany with field-by-field data, source pinned to FITBIT", async () => {
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    prismaMock.measurement.findMany.mockResolvedValue([]); // nothing live yet

    const { imported } = await upsertFitbitMeasurements("user1", [
      {
        type: "WEIGHT",
        value: 80.5,
        unit: "kg",
        measuredAt,
        externalId: "2026-05-10T07:00:00.000Z:weight",
      },
    ]);

    expect(imported).toBe(1);
    expect(prismaMock.measurement.update).not.toHaveBeenCalled();

    // The probe filters to LIVE FITBIT rows for the batch's externalIds.
    const probeArg = prismaMock.measurement.findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(probeArg.where).toMatchObject({
      userId: "user1",
      source: "FITBIT",
      deletedAt: null,
      externalId: { in: ["2026-05-10T07:00:00.000Z:weight"] },
    });

    const createArg = prismaMock.measurement.createMany.mock.calls[0]![0] as {
      data: Record<string, unknown>[];
      skipDuplicates: boolean;
    };
    expect(createArg.skipDuplicates).toBe(true);
    expect(createArg.data[0]).toMatchObject({
      userId: "user1",
      type: "WEIGHT",
      source: "FITBIT",
      value: 80.5,
      unit: "kg",
      externalId: "2026-05-10T07:00:00.000Z:weight",
    });
  });

  it("overwrites a matched LIVE row in place via update and bumps syncVersion", async () => {
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    // A re-fetched daily summary: the live row already exists.
    prismaMock.measurement.findMany.mockResolvedValue([
      { id: "m-live", type: "WEIGHT", externalId: "stats:weight:2026-05-10" },
    ]);

    const { imported } = await upsertFitbitMeasurements("user1", [
      {
        type: "WEIGHT",
        value: 79.9,
        unit: "kg",
        measuredAt,
        externalId: "stats:weight:2026-05-10",
      },
    ]);

    expect(imported).toBe(1);
    // No fresh insert — the live row was overwritten in place.
    expect(prismaMock.measurement.createMany).not.toHaveBeenCalled();
    const updateArg = prismaMock.measurement.update.mock.calls[0]![0] as {
      where: { id: string };
      data: { value: number; syncVersion: unknown };
    };
    expect(updateArg.where).toEqual({ id: "m-live" });
    expect(updateArg.data.value).toBe(79.9);
    expect(updateArg.data.syncVersion).toEqual({ increment: 1 });
  });

  it("does NOT resurrect a soft-deleted row — a tombstone is absent from the live probe, so a fresh insert is created", async () => {
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    // The user deleted this Fitbit reading: the tombstone (deletedAt set) is
    // excluded from the live probe, so findMany returns NOTHING for the key.
    prismaMock.measurement.findMany.mockResolvedValue([]);

    const { imported } = await upsertFitbitMeasurements("user1", [
      {
        type: "WEIGHT",
        value: 80.5,
        unit: "kg",
        measuredAt,
        externalId: "stats:weight:2026-05-10",
      },
    ]);

    // The deleted row is NOT updated/resurrected — a fresh insert is attempted
    // (the partial unique index `WHERE deleted_at IS NULL` keeps it from
    // colliding with the dead row, and skipDuplicates guards a live race).
    expect(imported).toBe(1);
    expect(prismaMock.measurement.update).not.toHaveBeenCalled();
    expect(prismaMock.measurement.createMany).toHaveBeenCalledTimes(1);
  });

  it("splits a mixed batch: matched-live → update, unmatched → createMany", async () => {
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    prismaMock.measurement.findMany.mockResolvedValue([
      { id: "m-live", type: "WEIGHT", externalId: "live-key" },
    ]);

    const { imported } = await upsertFitbitMeasurements("user1", [
      {
        type: "WEIGHT",
        value: 1,
        unit: "kg",
        measuredAt,
        externalId: "live-key",
      },
      {
        type: "WEIGHT",
        value: 2,
        unit: "kg",
        measuredAt,
        externalId: "fresh-key",
      },
    ]);

    expect(imported).toBe(2);
    expect(prismaMock.measurement.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.measurement.update.mock.calls[0]![0]).toMatchObject({
      where: { id: "m-live" },
    });
    const createArg = prismaMock.measurement.createMany.mock.calls[0]![0] as {
      data: Record<string, unknown>[];
    };
    expect(createArg.data).toHaveLength(1);
    expect(createArg.data[0]).toMatchObject({ externalId: "fresh-key" });
  });

  it("collapses a duplicate fresh key inside one batch to a single create (last-write-wins)", async () => {
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    prismaMock.measurement.findMany.mockResolvedValue([]);

    await upsertFitbitMeasurements("user1", [
      { type: "WEIGHT", value: 1, unit: "kg", measuredAt, externalId: "dup" },
      { type: "WEIGHT", value: 9, unit: "kg", measuredAt, externalId: "dup" },
    ]);

    const createArg = prismaMock.measurement.createMany.mock.calls[0]![0] as {
      data: Record<string, unknown>[];
    };
    expect(createArg.data).toHaveLength(1);
    // Last write wins.
    expect(createArg.data[0]!.value).toBe(9);
  });

  it("defers the rollup hook and returns touched keys when deferRollup is set", async () => {
    const { recomputeBucketsForMeasurement } =
      await import("@/lib/rollups/measurement-rollups");
    const measuredAt = new Date("2026-05-10T07:00:00.000Z");
    prismaMock.measurement.findMany.mockResolvedValue([]);

    const { imported, touched } = await upsertFitbitMeasurements(
      "user1",
      [
        {
          type: "WEIGHT",
          value: 80.5,
          unit: "kg",
          measuredAt,
          externalId: "k1",
        },
      ],
      { deferRollup: true },
    );

    expect(imported).toBe(1);
    expect(touched).toEqual([{ type: "WEIGHT", measuredAt }]);
    // The inline per-day hook is skipped on the deferred (backfill) path.
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
  });

  it("returns 0 without touching prisma for an empty batch", async () => {
    const { imported } = await upsertFitbitMeasurements("user1", []);
    expect(imported).toBe(0);
    expect(prismaMock.measurement.findMany).not.toHaveBeenCalled();
    expect(prismaMock.measurement.createMany).not.toHaveBeenCalled();
    expect(prismaMock.measurement.update).not.toHaveBeenCalled();
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
