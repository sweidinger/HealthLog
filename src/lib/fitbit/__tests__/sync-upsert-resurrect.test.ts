/**
 * Pins the tombstone-resurrect contract of `upsertFitbitMeasurements`.
 *
 * The measurements unique index on `(userId, type, source, externalId)` is
 * FULL — it covers soft-deleted rows — so a tombstoned row permanently owns
 * its key. The probe must therefore match tombstoned rows too and route them
 * into the UPDATE branch with `deletedAt: null`: treating them as absent plans
 * an insert that `skipDuplicates` drops SILENTLY against the tombstone's key,
 * wedging the key forever (the same wedge shipped live on the Google
 * transport).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, createManyMock, updateMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(async () => [] as unknown[]),
  createManyMock: vi.fn(async () => ({ count: 0 })),
  updateMock: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: findManyMock,
      createMany: createManyMock,
      update: updateMock,
    },
  },
}));
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn(async () => false),
  recordSyncFailure: vi.fn(async () => {}),
  recordSyncSuccess: vi.fn(async () => {}),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  recomputeUserRollups: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("@/lib/integrations/oauth-refresh", () => ({
  persistRotatedToken: vi.fn(async () => {}),
}));
vi.mock("../credentials", () => ({
  getUserFitbitCredentials: vi.fn(async () => null),
}));
vi.mock("../client", () => ({ refreshAccessToken: vi.fn() }));

import { upsertFitbitMeasurements } from "../sync";

const STEPS_READING = {
  type: "ACTIVITY_STEPS",
  value: 8123,
  unit: "steps",
  measuredAt: new Date("2026-07-08T00:00:00.000Z"),
  externalId: "stats:steps:2026-07-08",
};

beforeEach(() => {
  findManyMock.mockReset().mockResolvedValue([]);
  createManyMock.mockReset().mockResolvedValue({ count: 0 });
  updateMock.mockReset().mockResolvedValue({});
});

describe("upsertFitbitMeasurements — tombstones resurrect", () => {
  it("probes WITHOUT a deletedAt filter (a tombstoned row must be matched)", async () => {
    await upsertFitbitMeasurements("user-1", [STEPS_READING], {
      deferRollup: true,
    });
    const arg = (findManyMock.mock.calls[0] as unknown[])[0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where).toEqual({
      userId: "user-1",
      source: "FITBIT",
      externalId: { in: ["stats:steps:2026-07-08"] },
    });
    expect(arg.where).not.toHaveProperty("deletedAt");
  });

  it("routes a matched (tombstoned) row into an update that clears deletedAt", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "row-1",
        type: "ACTIVITY_STEPS",
        externalId: "stats:steps:2026-07-08",
      },
    ]);

    const { imported } = await upsertFitbitMeasurements(
      "user-1",
      [STEPS_READING],
      { deferRollup: true },
    );

    // No insert is planned for an owned key — the update resurrects in place.
    expect(createManyMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = (updateMock.mock.calls[0] as unknown[])[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(upd.where).toEqual({ id: "row-1" });
    expect(upd.data.deletedAt).toBeNull();
    expect(upd.data.value).toBe(8123);
    expect(upd.data.syncVersion).toEqual({ increment: 1 });
    expect(imported).toBe(1);
  });

  it("still creates a genuinely fresh key", async () => {
    createManyMock.mockResolvedValue({ count: 1 });
    const { imported } = await upsertFitbitMeasurements(
      "user-1",
      [STEPS_READING],
      { deferRollup: true },
    );
    expect(updateMock).not.toHaveBeenCalled();
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(imported).toBe(1);
  });
});
