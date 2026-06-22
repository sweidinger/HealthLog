/**
 * v1.20.0 — Fitbit health-metrics sync end-to-end (classic Fitbit Web API).
 *
 * Drives `syncUserMetrics` against a mocked classic `api.fitbit.com` transport
 * and the real Postgres testcontainer. Asserts:
 *   - Each mapped reading writes one Measurement row keyed
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
      fitbitUserId: "fb-1",
      accessToken: encrypt("access-token"),
      refreshToken: encrypt("refresh-token"),
      // Token valid for an hour — keeps `getValidToken` off the refresh path.
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope:
        "activity heartrate oxygen_saturation profile respiratory_rate weight",
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Stub global fetch for the classic Fitbit Web API. The metrics sync hits one
 * bespoke endpoint per metric (each a `/1/user/-/<resource>/date/{start}/{end}`
 * range read), so match on the resource path segment and return its seeded
 * classic-shaped body. Any endpoint not seeded returns its empty envelope.
 *
 * Each metric resource is keyed by a discriminating substring of its URL path:
 *   - `body/log/weight` → `{ weight: [...] }`
 *   - `body/log/fat`    → `{ fat: [...] }`
 *   - `spo2`            → bare `[ { dateTime, value: { avg } } ]`
 *   - `hrv`             → `{ hrv: [...] }`
 *   - `activities/heart`→ `{ "activities-heart": [...] }`
 *   - `br`             → `{ br: [...] }`
 */
function stubFitbit(byPath: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      for (const [needle, body] of Object.entries(byPath)) {
        if (url.includes(needle)) {
          return { status: 200, json: async () => body };
        }
      }
      // Unseeded endpoint: empty body so its mapper yields no rows.
      return { status: 200, json: async () => ({}) };
    }),
  );
}

describe("syncUserMetrics — integration", () => {
  it("writes one Measurement row per mapped reading and folds a DAY rollup", async () => {
    stubFitbit({
      "body/log/weight": {
        // No logId → externalId anchors on the instant ISO (date + time).
        weight: [{ date: "2026-05-10", time: "07:00:00", weight: 80.5 }],
      },
      "activities/heart": {
        "activities-heart": [
          { dateTime: "2026-05-10", value: { restingHeartRate: 55 } },
        ],
      },
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
    const body = (kg: number) => ({
      // No logId → stable instant anchor → same dedup key on re-fetch.
      weight: [{ date: "2026-05-10", time: "07:00:00", weight: kg }],
    });

    stubFitbit({ "body/log/weight": body(80.5) });
    const { syncUserMetrics } = await import("@/lib/fitbit/sync-metrics");
    await syncUserMetrics(TEST_USER_ID);

    // Re-fetch the same window with a corrected value (same anchor → same key).
    stubFitbit({ "body/log/weight": body(81.2) });
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

    stubFitbit({
      "body/log/weight": {
        weight: [{ date: "2026-05-10", time: "07:00:00", weight: 80.5 }],
      },
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
