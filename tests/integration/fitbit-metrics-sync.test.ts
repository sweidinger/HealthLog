/**
 * v1.12.0 — Fitbit / Google Health metrics-sync end-to-end.
 *
 * Drives `syncUserMetrics` against a mocked Google Health `dataPoints.list`
 * response and the real Postgres testcontainer. Asserts:
 *   - Each mapped data point writes one Measurement row keyed
 *     `(userId, type, source=FITBIT, externalId)`.
 *   - A second sync of the same window UPSERTS in place (no duplicates) and
 *     bumps `syncVersion` — the idempotency contract.
 *   - A DAY measurement_rollup row is folded for the touched type/day.
 *   - A Fitbit weight and a Withings weight on the same day both persist (the
 *     per-source first-write-wins contract — no ingest-time collapse for a
 *     server-owned source pair).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Crypto reads `ENCRYPTION_KEY` lazily on first encrypt(). Pin a deterministic
// 32-byte test key before any `@/lib/crypto` import so the spec is self-contained.
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";

import { getPrismaClient, truncateAllTables } from "./setup";

// `recomputeBucketsForMeasurement` enqueues WEEK/MONTH/YEAR jobs via pg-boss;
// detach the boss so the DAY fold runs without a live queue.
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const TEST_USER_ID = "user-fitbit-metrics-sync";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "fitbit-metrics-sync",
      email: "fitbit-metrics-sync@example.test",
    },
  });
  await prisma.fitbitConnection.create({
    data: {
      userId: TEST_USER_ID,
      fitbitUserId: "gh-1",
      accessToken: encrypt("access-token"),
      refreshToken: encrypt("refresh-token"),
      // Token valid for an hour — keeps `getValidToken` off the refresh path.
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope:
        "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Stub global fetch so each metric data-type read returns its own data points.
 * The metrics sync hits one URL per data type (kebab-cased in the path); match
 * on the path segment and return the matching point set, or an empty page for
 * any type we don't seed.
 */
function stubGoogleHealth(byPathSegment: Record<string, unknown[]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const match = /dataTypes\/([^/]+)\/dataPoints/.exec(url);
      const seg = match?.[1] ?? "";
      const dataPoints = byPathSegment[seg] ?? [];
      return {
        status: 200,
        json: async () => ({ dataPoints }),
      };
    }),
  );
}

describe("syncUserMetrics — integration", () => {
  it("writes one Measurement row per mapped data point and folds a DAY rollup", async () => {
    stubGoogleHealth({
      weight: [
        {
          weight: {
            kilograms: 80.5,
            sample_time: { physical_time: "2026-05-10T07:00:00.000Z" },
          },
        },
      ],
      "daily-resting-heart-rate": [
        {
          daily_resting_heart_rate: {
            beats_per_minute: 55,
            date: { year: 2026, month: 5, day: 10 },
          },
        },
      ],
    });

    const { syncUserMetrics } = await import("@/lib/fitbit/sync-metrics");
    const imported = await syncUserMetrics(TEST_USER_ID);
    expect(imported).toBe(2);

    const prisma = getPrismaClient();
    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, source: "FITBIT" },
      orderBy: { type: "asc" },
    });
    expect(rows).toHaveLength(2);
    const weight = rows.find((r) => r.type === "WEIGHT");
    expect(weight?.value).toBe(80.5);
    expect(weight?.unit).toBe("kg");
    expect(weight?.externalId).toBe("2026-05-10T07:00:00.000Z:weight");

    // A DAY rollup folded for the touched weight day.
    const rollup = await prisma.measurementRollup.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "WEIGHT",
        granularity: "DAY",
        source: "FITBIT",
      },
    });
    expect(rollup.length).toBeGreaterThanOrEqual(1);
  });

  it("upserts in place on a re-sync of the same window (no duplicates) and bumps syncVersion", async () => {
    const point = (kg: number) => ({
      weight: {
        kilograms: kg,
        sample_time: { physical_time: "2026-05-10T07:00:00.000Z" },
      },
    });

    stubGoogleHealth({ weight: [point(80.5)] });
    const { syncUserMetrics } = await import("@/lib/fitbit/sync-metrics");
    await syncUserMetrics(TEST_USER_ID);

    // Re-fetch the same window with a corrected value (same anchor → same key).
    stubGoogleHealth({ weight: [point(81.2)] });
    await syncUserMetrics(TEST_USER_ID);

    const prisma = getPrismaClient();
    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, source: "FITBIT", type: "WEIGHT" },
    });
    // Exactly one row — the second sync overwrote in place.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(81.2);
    // syncVersion bumped on the update path.
    expect(rows[0]!.syncVersion).toBeGreaterThanOrEqual(2);
  });

  it("keeps a Fitbit weight and a Withings weight on the same day as separate rows", async () => {
    const prisma = getPrismaClient();
    // A pre-existing Withings weight for the same day.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEIGHT",
        value: 79.9,
        unit: "kg",
        source: "WITHINGS",
        measuredAt: new Date("2026-05-10T06:30:00.000Z"),
        externalId: "withings:weight:1",
      },
    });

    stubGoogleHealth({
      weight: [
        {
          weight: {
            kilograms: 80.5,
            sample_time: { physical_time: "2026-05-10T07:00:00.000Z" },
          },
        },
      ],
    });
    const { syncUserMetrics } = await import("@/lib/fitbit/sync-metrics");
    await syncUserMetrics(TEST_USER_ID);

    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "WEIGHT" },
      orderBy: { source: "asc" },
    });
    // Both sources persist — no ingest-time collapse for a server-owned pair.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.source).sort()).toEqual(["FITBIT", "WITHINGS"]);
  });
});
