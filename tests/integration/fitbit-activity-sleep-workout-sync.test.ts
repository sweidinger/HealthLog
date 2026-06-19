/**
 * v1.12.0 (W5) — Fitbit activity / sleep / workout sync end-to-end.
 *
 * Drives the three W5 resource syncs against a mocked Google Health
 * `dataPoints.list` and the real Postgres testcontainer. Asserts:
 *   - Daily cumulative activity rows mint a `stats:`-prefixed externalId and a
 *     re-fetched day OVERWRITES the row in place (no duplicate) — the
 *     Apple-Health daily-total overwrite contract.
 *   - Sleep sessions upsert per-stage SLEEP_DURATION rows carrying the shared
 *     SleepStage enum, distinct per stage under the dedup key.
 *   - A Fitbit exercise session writes a Workout row keyed
 *     (userId, source=FITBIT, externalId); a Fitbit run and an Apple-Health twin
 *     both persist, and the read-time canonical picker collapses them to the
 *     ladder winner (APPLE_HEALTH > WHOOP > FITBIT).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pin a deterministic 32-byte key before any `@/lib/crypto` import.
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const TEST_USER_ID = "user-fitbit-w5-sync";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "fitbit-w5-sync",
      email: "fitbit-w5-sync@example.test",
    },
  });
  await prisma.fitbitConnection.create({
    data: {
      userId: TEST_USER_ID,
      fitbitUserId: "gh-w5",
      accessToken: encrypt("access-token"),
      refreshToken: encrypt("refresh-token"),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope:
        "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly https://www.googleapis.com/auth/googlehealth.sleep.readonly",
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Stub fetch: match the kebab path segment → its seeded data points. */
function stubGoogleHealth(byPathSegment: Record<string, unknown[]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const match = /dataTypes\/([^/?]+)\/dataPoints/.exec(url);
      const seg = match?.[1] ?? "";
      const dataPoints = byPathSegment[seg] ?? [];
      return { status: 200, json: async () => ({ dataPoints }) };
    }),
  );
}

// INTERVAL data type: the daily total is bucketed into an `interval` carrying a
// physical `start_time` (the day's start instant), NOT a bare civil `date`.
const DAY_INTERVAL = { start_time: "2026-05-10T00:00:00.000Z" };

describe("syncUserActivity — cumulative overwrite", () => {
  it("mints a stats: externalId and overwrites the same day on re-sync (no duplicate)", async () => {
    stubGoogleHealth({
      steps: [{ steps: { count: 8000, interval: DAY_INTERVAL } }],
    });
    const { syncUserActivity } = await import("@/lib/fitbit/sync-activity");
    const first = await syncUserActivity(TEST_USER_ID);
    expect(first).toBe(1);

    const prisma = getPrismaClient();
    let rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS", source: "FITBIT" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(8000);
    expect(rows[0]!.unit).toBe("steps");
    // The daily-total overwrite shape: stats:<tag>:<YYYY-MM-DD>.
    expect(rows[0]!.externalId).toBe("stats:steps:2026-05-10");

    // Re-fetch the same day with a corrected total → overwrite, not duplicate.
    stubGoogleHealth({
      steps: [{ steps: { count: 9123, interval: DAY_INTERVAL } }],
    });
    await syncUserActivity(TEST_USER_ID);

    rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS", source: "FITBIT" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(9123);
    expect(rows[0]!.syncVersion).toBeGreaterThanOrEqual(2);
  });

  it("preserves a 0-step rest day rather than dropping it as a gap", async () => {
    stubGoogleHealth({
      steps: [{ steps: { count: 0, interval: DAY_INTERVAL } }],
    });
    const { syncUserActivity } = await import("@/lib/fitbit/sync-activity");
    const imported = await syncUserActivity(TEST_USER_ID);
    expect(imported).toBe(1);

    const prisma = getPrismaClient();
    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS", source: "FITBIT" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(0);
  });
});

describe("syncUserSleep — per-stage upsert", () => {
  it("writes one SLEEP_DURATION row per stage carrying the SleepStage enum", async () => {
    const session = {
      sleep: {
        startTime: "2026-05-10T22:00:00.000Z",
        endTime: "2026-05-11T06:00:00.000Z",
        segments: [
          {
            stage: "light",
            startTime: "2026-05-10T22:00:00.000Z",
            endTime: "2026-05-10T23:00:00.000Z",
          },
          {
            stage: "deep",
            startTime: "2026-05-10T23:00:00.000Z",
            endTime: "2026-05-11T00:30:00.000Z",
          },
          {
            stage: "rem",
            startTime: "2026-05-11T00:30:00.000Z",
            endTime: "2026-05-11T01:15:00.000Z",
          },
        ],
      },
    };
    stubGoogleHealth({ sleep: [session] });
    const { syncUserSleep } = await import("@/lib/fitbit/sync-sleep");
    const imported = await syncUserSleep(TEST_USER_ID);
    expect(imported).toBe(3);

    const prisma = getPrismaClient();
    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "SLEEP_DURATION", source: "FITBIT" },
      orderBy: { sleepStage: "asc" },
    });
    expect(rows).toHaveLength(3);
    const byStage = Object.fromEntries(rows.map((r) => [r.sleepStage, r]));
    expect(byStage.CORE!.value).toBe(60); // light → CORE, 60 min
    expect(byStage.DEEP!.value).toBe(90);
    expect(byStage.REM!.value).toBe(45);
    // Each stage row is distinct under the dedup key.
    expect(new Set(rows.map((r) => r.externalId)).size).toBe(3);

    // Re-score the same night → overwrite in place (still 3 rows).
    await syncUserSleep(TEST_USER_ID);
    const again = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "SLEEP_DURATION", source: "FITBIT" },
    });
    expect(again).toHaveLength(3);
  });
});

describe("syncUserWorkout — Workout rows + cross-source dedup", () => {
  it("writes a Workout row keyed (userId, FITBIT, externalId)", async () => {
    stubGoogleHealth({
      exercise: [
        {
          exercise: {
            session_id: "ex-1",
            activity_type: "run",
            startTime: "2026-05-10T07:00:00.000Z",
            endTime: "2026-05-10T07:40:00.000Z",
            active_kilocalories: 380,
            distance: { meters: 7000 },
            average_heart_rate: { beats_per_minute: 150 },
          },
        },
      ],
    });
    const { syncUserWorkout } = await import("@/lib/fitbit/sync-workout");
    const imported = await syncUserWorkout(TEST_USER_ID);
    expect(imported).toBe(1);

    const prisma = getPrismaClient();
    const workouts = await prisma.workout.findMany({
      where: { userId: TEST_USER_ID, source: "FITBIT" },
    });
    expect(workouts).toHaveLength(1);
    expect(workouts[0]).toMatchObject({
      externalId: "ex-1",
      sportType: "running",
      durationSec: 40 * 60,
      totalEnergyKcal: 380,
      totalDistanceM: 7000,
      avgHeartRate: 150,
    });

    // Re-fetch → overwrite in place, still one row.
    await syncUserWorkout(TEST_USER_ID);
    expect(
      await prisma.workout.count({
        where: { userId: TEST_USER_ID, source: "FITBIT" },
      }),
    ).toBe(1);
  });

  it("keeps a Fitbit + Apple-Health twin as two rows; the read-time picker collapses them", async () => {
    const prisma = getPrismaClient();
    // A pre-existing Apple-Health run at the same wall-clock time.
    await prisma.workout.create({
      data: {
        userId: TEST_USER_ID,
        source: "APPLE_HEALTH",
        externalId: "hk-run-1",
        sportType: "running",
        startedAt: new Date("2026-05-10T07:00:30.000Z"),
        endedAt: new Date("2026-05-10T07:40:00.000Z"),
        durationSec: 2370,
      },
    });

    stubGoogleHealth({
      exercise: [
        {
          exercise: {
            session_id: "ex-1",
            activity_type: "run",
            startTime: "2026-05-10T07:00:00.000Z",
            endTime: "2026-05-10T07:40:00.000Z",
          },
        },
      ],
    });
    const { syncUserWorkout } = await import("@/lib/fitbit/sync-workout");
    await syncUserWorkout(TEST_USER_ID);

    // Both rows persist at ingest (no server-owned-pair collapse on write).
    const allRows = await prisma.workout.findMany({
      where: { userId: TEST_USER_ID },
      orderBy: { source: "asc" },
    });
    expect(allRows).toHaveLength(2);
    expect(allRows.map((r) => r.source).sort()).toEqual([
      "APPLE_HEALTH",
      "FITBIT",
    ]);

    // Read-time canonical picker collapses the twin to the ladder winner.
    const { pickCanonicalWorkoutRows } =
      await import("@/lib/measurements/pick-canonical-workout-rows");
    const canonical = pickCanonicalWorkoutRows(
      allRows.map((r) => ({
        startedAt: r.startedAt,
        sportType: r.sportType,
        source: r.source,
      })),
      null,
    );
    expect(canonical).toHaveLength(1);
    // APPLE_HEALTH ranks above FITBIT in the default ladder.
    expect(canonical[0]!.source).toBe("APPLE_HEALTH");
  });
});
