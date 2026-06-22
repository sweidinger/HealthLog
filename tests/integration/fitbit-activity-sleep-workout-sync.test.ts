/**
 * v1.20.0 — Fitbit activity / sleep / workout sync end-to-end (classic API).
 *
 * Drives the three resource syncs against a mocked classic `api.fitbit.com`
 * transport and the real Postgres testcontainer. Asserts:
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
      // Pin UTC so the classic offset-less local wall-clock timestamps Fitbit
      // emits on the 1.2 sleep log + activities list resolve 1:1 to UTC instants
      // — the sleep/workout assertions below anchor on those instants, and the
      // workout twin must land in the same 5-minute picker bucket as its
      // Apple-Health counterpart regardless of the server default zone.
      timezone: "UTC",
    },
  });
  await prisma.fitbitConnection.create({
    data: {
      userId: TEST_USER_ID,
      fitbitUserId: "fb-w5",
      accessToken: encrypt("access-token"),
      refreshToken: encrypt("refresh-token"),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "activity sleep",
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Stub global fetch for the classic Fitbit Web API. Each resource sync hits one
 * bespoke endpoint per metric; match on a discriminating substring of the URL
 * path and return its seeded classic-shaped body. Endpoints not seeded return
 * an empty envelope so their mappers yield no rows (the activity sync walks
 * steps + distance + activityCalories + floors + cardioscore, so the unseeded
 * siblings must produce zero rows for the per-metric counts to hold).
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
      return { status: 200, json: async () => ({}) };
    }),
  );
}

describe("syncUserActivity — cumulative overwrite", () => {
  it("mints a stats: externalId and overwrites the same day on re-sync (no duplicate)", async () => {
    stubFitbit({
      // Classic activities time series: civil-date rows, string values.
      "activities/steps": {
        "activities-steps": [{ dateTime: "2026-05-10", value: "8000" }],
      },
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
    stubFitbit({
      "activities/steps": {
        "activities-steps": [{ dateTime: "2026-05-10", value: "9123" }],
      },
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
    stubFitbit({
      "activities/steps": {
        "activities-steps": [{ dateTime: "2026-05-10", value: "0" }],
      },
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
    // Classic 1.2 sleep log: one session, per-segment `levels.data`. The segment
    // `dateTime` is its START (offset-less local wall-clock); seconds → minutes;
    // measuredAt = START + seconds. logId anchors the externalId.
    const session = {
      logId: 555001,
      startTime: "2026-05-10T22:00:00.000",
      endTime: "2026-05-11T06:00:00.000",
      levels: {
        data: [
          {
            dateTime: "2026-05-10T22:00:00.000",
            level: "light",
            seconds: 3600,
          },
          { dateTime: "2026-05-10T23:00:00.000", level: "deep", seconds: 5400 },
          { dateTime: "2026-05-11T00:30:00.000", level: "rem", seconds: 2700 },
        ],
      },
    };
    stubFitbit({ "sleep/date": { sleep: [session] } });
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
    stubFitbit({
      // Classic activities list: logId anchor, ms duration, km distance.
      "activities/list": {
        activities: [
          {
            logId: 90001,
            activityName: "run",
            startTime: "2026-05-10T07:00:00.000",
            duration: 40 * 60 * 1000,
            calories: 380,
            distance: 7, // km (metric locale) → 7000 m
            averageHeartRate: 150,
          },
        ],
      },
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
      // Classic externalId = String(logId).
      externalId: "90001",
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

    stubFitbit({
      "activities/list": {
        activities: [
          {
            logId: 90001,
            activityName: "run",
            startTime: "2026-05-10T07:00:00.000",
            duration: 40 * 60 * 1000,
          },
        ],
      },
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
