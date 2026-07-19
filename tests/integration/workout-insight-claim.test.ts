/**
 * The `WorkoutInsight` row's structural claims, against real Postgres.
 *
 * Unit mocks cannot prove any of this, and each one is load-bearing:
 *
 *   - **One paragraph per workout** is a unique INDEX. A mocked `upsert` will
 *     happily accept a second row for the same workout; the database is what
 *     actually refuses, and it is the half of the double-post defence that
 *     holds when the singleton queue key does not.
 *   - **The cascade** is an FK constraint. Workout deletes are HARD deletes, so
 *     a paragraph that outlived its workout would be an orphaned description of
 *     a session the user believes they erased. That is a data-retention claim,
 *     not a tidiness one, and only the database enforces it.
 *   - **The daily-cap count** reads an index over `(user_id, generated_at)`.
 *     Whether the window actually selects the right rows is a SQL fact.
 *
 * Every test writes through Prisma the way the worker does, so a schema change
 * that dropped a constraint fails here rather than in production.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { claimWorkoutInsightGeneration } from "@/lib/jobs/workout-insight-generate";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function createUser(username: string) {
  return getPrismaClient().user.create({
    data: { username, email: `${username}@example.test`, role: "USER" },
  });
}

async function createWorkout(
  userId: string,
  startedAt: Date,
  externalId: string,
) {
  return getPrismaClient().workout.create({
    data: {
      userId,
      sportType: "cycling",
      startedAt,
      endedAt: new Date(startedAt.getTime() + 45 * 60_000),
      durationSec: 2700,
      source: "APPLE_HEALTH",
      externalId,
    },
  });
}

function insightData(userId: string, workoutId: string, generatedAt: Date) {
  return {
    userId,
    workoutId,
    paragraphEncrypted: Buffer.from("ciphertext-stand-in", "utf8"),
    inputHash: "hash-1",
    promptVersion: "1.0.0",
    providerType: "local",
    locale: "en",
    generatedAt,
  };
}

describe("WorkoutInsight — one paragraph per workout", () => {
  it("refuses a second row for the same workout", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("wi-unique");
    const workout = await createWorkout(
      user.id,
      new Date("2026-07-18T06:00:00Z"),
      "ext-1",
    );

    await prisma.workoutInsight.create({
      data: insightData(user.id, workout.id, new Date("2026-07-18T06:50:00Z")),
    });

    // The durable half of the double-post defence. A watch that posted the same
    // session twice and somehow cleared the queue's singleton key still cannot
    // buy a second paragraph.
    await expect(
      prisma.workoutInsight.create({
        data: {
          ...insightData(user.id, workout.id, new Date("2026-07-18T07:00:00Z")),
          inputHash: "hash-2",
        },
      }),
    ).rejects.toThrow();

    expect(await prisma.workoutInsight.count()).toBe(1);
  });

  it("upserts in place rather than creating a twin", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("wi-upsert");
    const workout = await createWorkout(
      user.id,
      new Date("2026-07-18T06:00:00Z"),
      "ext-1",
    );
    const data = insightData(
      user.id,
      workout.id,
      new Date("2026-07-18T06:50:00Z"),
    );

    await prisma.workoutInsight.upsert({
      where: { workoutId: workout.id },
      create: data,
      update: data,
    });
    await prisma.workoutInsight.upsert({
      where: { workoutId: workout.id },
      create: { ...data, inputHash: "hash-2" },
      update: { ...data, inputHash: "hash-2" },
    });

    expect(await prisma.workoutInsight.count()).toBe(1);
    const row = await prisma.workoutInsight.findUniqueOrThrow({
      where: { workoutId: workout.id },
    });
    expect(row.inputHash).toBe("hash-2");
  });

  it("keeps two workouts on the same day independent", async () => {
    // Two sessions in one day are two events and both deserve a paragraph —
    // unlike the day-scoped arrival marker, which can only be claimed once.
    const prisma = getPrismaClient();
    const user = await createUser("wi-two");
    const morning = await createWorkout(
      user.id,
      new Date("2026-07-18T06:00:00Z"),
      "ext-am",
    );
    const evening = await createWorkout(
      user.id,
      new Date("2026-07-18T18:00:00Z"),
      "ext-pm",
    );

    await prisma.workoutInsight.create({
      data: insightData(user.id, morning.id, new Date("2026-07-18T06:50:00Z")),
    });
    await prisma.workoutInsight.create({
      data: insightData(user.id, evening.id, new Date("2026-07-18T18:50:00Z")),
    });

    expect(await prisma.workoutInsight.count()).toBe(2);
  });
});

describe("WorkoutInsight — cascade", () => {
  it("disappears with its workout", async () => {
    // Workout deletes are HARD deletes. A paragraph describing a session the
    // user erased must not survive it.
    const prisma = getPrismaClient();
    const user = await createUser("wi-cascade");
    const workout = await createWorkout(
      user.id,
      new Date("2026-07-18T06:00:00Z"),
      "ext-1",
    );
    await prisma.workoutInsight.create({
      data: insightData(user.id, workout.id, new Date("2026-07-18T06:50:00Z")),
    });

    await prisma.workout.delete({ where: { id: workout.id } });

    expect(await prisma.workoutInsight.count()).toBe(0);
  });

  it("disappears with its user", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("wi-user-cascade");
    const workout = await createWorkout(
      user.id,
      new Date("2026-07-18T06:00:00Z"),
      "ext-1",
    );
    await prisma.workoutInsight.create({
      data: insightData(user.id, workout.id, new Date("2026-07-18T06:50:00Z")),
    });

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.workoutInsight.count()).toBe(0);
  });
});

describe("WorkoutInsight — the daily-cap count", () => {
  it("counts only this user's rows inside the window", async () => {
    const prisma = getPrismaClient();
    const mine = await createUser("wi-cap-mine");
    const other = await createUser("wi-cap-other");

    // Three of mine today, one of mine yesterday, one belonging to someone else.
    const today = new Date("2026-07-18T09:00:00Z");
    for (let i = 0; i < 3; i++) {
      const w = await createWorkout(
        mine.id,
        new Date(today.getTime() + i * 3600_000),
        `ext-today-${i}`,
      );
      await prisma.workoutInsight.create({
        data: insightData(
          mine.id,
          w.id,
          new Date(today.getTime() + i * 3600_000),
        ),
      });
    }
    const yesterdayWorkout = await createWorkout(
      mine.id,
      new Date("2026-07-17T09:00:00Z"),
      "ext-yesterday",
    );
    await prisma.workoutInsight.create({
      data: insightData(
        mine.id,
        yesterdayWorkout.id,
        new Date("2026-07-17T09:30:00Z"),
      ),
    });
    const otherWorkout = await createWorkout(
      other.id,
      new Date("2026-07-18T09:00:00Z"),
      "ext-other",
    );
    await prisma.workoutInsight.create({
      data: insightData(
        other.id,
        otherWorkout.id,
        new Date("2026-07-18T10:00:00Z"),
      ),
    });

    const dayStart = new Date("2026-07-18T00:00:00Z");
    const count = await prisma.workoutInsight.count({
      where: { userId: mine.id, generatedAt: { gte: dayStart } },
    });

    // Not 4 (yesterday's is outside the window) and not 5 (the other user's is
    // outside the tenancy narrow).
    expect(count).toBe(3);
  });
});

describe("WorkoutInsightGenerationClaim — concurrent ownership and cap", () => {
  const now = new Date("2026-07-18T15:00:00.000Z");
  const dayStart = new Date("2026-07-17T22:00:00.000Z");
  const localDate = "2026-07-18";

  it("atomically grants at most four different workouts for one user-local day", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("wi-claim-cap");
    const workouts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createWorkout(
          user.id,
          new Date(now.getTime() - (index + 1) * 3_600_000),
          `ext-concurrent-${index}`,
        ),
      ),
    );

    const outcomes = await Promise.all(
      workouts.map((workout) =>
        claimWorkoutInsightGeneration({
          userId: user.id,
          workoutId: workout.id,
          localDate,
          dayStart,
          now,
        }),
      ),
    );

    expect(
      outcomes.filter((outcome) => outcome.status === "claimed"),
    ).toHaveLength(4);
    expect(
      outcomes.filter(
        (outcome) =>
          outcome.status === "skipped" && outcome.reason === "daily_cap",
      ),
    ).toHaveLength(4);
    expect(
      await prisma.workoutInsightGenerationClaim.count({
        where: { userId: user.id, localDate },
      }),
    ).toBe(4);
  });

  it("reclaims a stale pre-provider claim without creating a second row", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("wi-stale-claim");
    const workout = await createWorkout(
      user.id,
      new Date("2026-07-18T13:00:00.000Z"),
      "ext-stale",
    );
    await prisma.workoutInsightGenerationClaim.create({
      data: {
        userId: user.id,
        workoutId: workout.id,
        localDate,
        claimId: "dead-worker",
        claimedAt: new Date("2026-07-18T14:00:00.000Z"),
      },
    });

    const outcome = await claimWorkoutInsightGeneration({
      userId: user.id,
      workoutId: workout.id,
      localDate,
      dayStart,
      now,
    });

    expect(outcome.status).toBe("claimed");
    if (outcome.status !== "claimed") throw new Error("claim not recovered");
    expect(outcome.claimId).not.toBe("dead-worker");
    const rows = await prisma.workoutInsightGenerationClaim.findMany({
      where: { workoutId: workout.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.claimId).toBe(outcome.claimId);
  });

  it("counts a pre-migration insight row against the local-day cap", async () => {
    const prisma = getPrismaClient();
    const user = await createUser("wi-legacy-cap");
    const legacyWorkout = await createWorkout(
      user.id,
      new Date("2026-07-18T07:00:00.000Z"),
      "ext-legacy",
    );
    await prisma.workoutInsight.create({
      data: insightData(
        user.id,
        legacyWorkout.id,
        new Date("2026-07-18T08:00:00.000Z"),
      ),
    });
    const candidates = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createWorkout(
          user.id,
          new Date(`2026-07-18T${10 + index}:00:00.000Z`),
          `ext-new-${index}`,
        ),
      ),
    );

    const outcomes = await Promise.all(
      candidates.map((workout) =>
        claimWorkoutInsightGeneration({
          userId: user.id,
          workoutId: workout.id,
          localDate,
          dayStart,
          now,
        }),
      ),
    );

    expect(
      outcomes.filter((outcome) => outcome.status === "claimed"),
    ).toHaveLength(3);
    expect(outcomes).toContainEqual({
      status: "skipped",
      reason: "daily_cap",
    });
  });
});
