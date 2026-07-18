/**
 * Integration coverage for the raw-SQL workout-sport backfills:
 *   - `0247_backfill_whoop_workout_sport`
 *   - `0251_backfill_strava_workout_sport`
 *
 * These two data migrations rewrite historical `Workout.sport_type` rows
 * that predate the write-time canonical mappers (`mapWhoopSportType` /
 * `mapStravaSportType`). They are the thinnest-tested class in the tree —
 * one-shot SQL that rewrites real rows with no seed→apply→assert harness
 * (data-integrity audit L2 / senior-dev audit L2). This test seeds
 * pre-backfill rows, applies the EXACT migration SQL from disk, and asserts
 * the canonical relabel, the source guard, and idempotency.
 *
 * Runs against the testcontainer Postgres so the real `regexp_replace` /
 * `lower` / `trim` normalisation the migrations rely on is exercised
 * end-to-end. Requires Docker / OrbStack; driven by CI's integration job
 * (and `pnpm test:integration` locally).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import type {
  MeasurementSource,
  PrismaClient,
} from "@/generated/prisma/client";

const migrationSql = (name: string): string =>
  readFileSync(
    resolve(process.cwd(), "prisma", "migrations", name, "migration.sql"),
    "utf8",
  );

const WHOOP_BACKFILL_SQL = migrationSql("0247_backfill_whoop_workout_sport");
const STRAVA_BACKFILL_SQL = migrationSql("0251_backfill_strava_workout_sport");

let seedCounter = 0;

async function seedWorkout(
  prisma: PrismaClient,
  userId: string,
  source: MeasurementSource,
  sportType: string,
): Promise<string> {
  seedCounter += 1;
  const startedAt = new Date(
    Date.UTC(2026, 0, 1, 6, 0, 0) + seedCounter * 60_000,
  );
  const row = await prisma.workout.create({
    data: {
      userId,
      source,
      sportType,
      externalId: `seed-${source}-${seedCounter}`,
      startedAt,
      endedAt: new Date(startedAt.getTime() + 30 * 60_000),
      durationSec: 30 * 60,
    },
    select: { id: true },
  });
  return row.id;
}

async function sportOf(prisma: PrismaClient, id: string): Promise<string> {
  const row = await prisma.workout.findUniqueOrThrow({
    where: { id },
    select: { sportType: true },
  });
  return row.sportType;
}

describe("workout-sport backfill migrations — integration", () => {
  beforeEach(async () => {
    await truncateAllTables(getPrismaClient());
    seedCounter = 0;
  });

  async function makeUser(prisma: PrismaClient, tag: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        username: `backfill-${tag}`,
        email: `backfill-${tag}@example.test`,
        role: "USER",
      },
    });
    return user.id;
  }

  it("0247 relabels WHOOP rows to canonical sports and leaves other sources alone", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser(prisma, "whoop");

    // Pre-backfill WHOOP rows in both shapes the fix targets.
    const placeholderCycling = await seedWorkout(
      prisma,
      userId,
      "WHOOP",
      "whoop_sport_1", // numeric-id placeholder → cycling
    );
    const rawNameSpin = await seedWorkout(
      prisma,
      userId,
      "WHOOP",
      "spin", // raw sport_name → cycling
    );
    const mixedCaseRun = await seedWorkout(
      prisma,
      userId,
      "WHOOP",
      "Running", // case/normalisation → running
    );
    const unknownArm = await seedWorkout(
      prisma,
      userId,
      "WHOOP",
      "quidditch", // unrecognised → ELSE 'other'
    );
    const alreadyCanonical = await seedWorkout(
      prisma,
      userId,
      "WHOOP",
      "cycling", // already canonical — excluded by the WHERE guard
    );
    // A Strava row with a raw label must NOT be touched by the WHOOP pass.
    const stravaUntouched = await seedWorkout(prisma, userId, "STRAVA", "Ride");

    await prisma.$executeRawUnsafe(WHOOP_BACKFILL_SQL);

    expect(await sportOf(prisma, placeholderCycling)).toBe("cycling");
    expect(await sportOf(prisma, rawNameSpin)).toBe("cycling");
    expect(await sportOf(prisma, mixedCaseRun)).toBe("running");
    expect(await sportOf(prisma, unknownArm)).toBe("other");
    expect(await sportOf(prisma, alreadyCanonical)).toBe("cycling");
    // Source guard: the Strava row is left verbatim for its own migration.
    expect(await sportOf(prisma, stravaUntouched)).toBe("Ride");
  });

  it("0247 is idempotent — a second apply touches zero rows", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser(prisma, "whoop-idem");
    await seedWorkout(prisma, userId, "WHOOP", "whoop_sport_1");
    await seedWorkout(prisma, userId, "WHOOP", "spin");
    await seedWorkout(prisma, userId, "WHOOP", "quidditch");

    const firstAffected = await prisma.$executeRawUnsafe(WHOOP_BACKFILL_SQL);
    expect(firstAffected).toBe(3);

    const secondAffected = await prisma.$executeRawUnsafe(WHOOP_BACKFILL_SQL);
    expect(secondAffected).toBe(0);
  });

  it("0251 relabels STRAVA rows to canonical sports and leaves other sources alone", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser(prisma, "strava");

    const ride = await seedWorkout(prisma, userId, "STRAVA", "Ride");
    const virtualRide = await seedWorkout(
      prisma,
      userId,
      "STRAVA",
      "VirtualRide", // non-alnum stripped → virtualride → cycling
    );
    const trailRun = await seedWorkout(prisma, userId, "STRAVA", "TrailRun");
    const literalWorkout = await seedWorkout(
      prisma,
      userId,
      "STRAVA",
      "workout", // pre-fix literal fallback → other
    );
    const unknownArm = await seedWorkout(prisma, userId, "STRAVA", "Quidditch");
    const alreadyCanonical = await seedWorkout(
      prisma,
      userId,
      "STRAVA",
      "running",
    );
    // A WHOOP placeholder must NOT be touched by the Strava pass.
    const whoopUntouched = await seedWorkout(
      prisma,
      userId,
      "WHOOP",
      "whoop_sport_1",
    );
    // A MANUAL row with a raw-looking label must be left alone entirely.
    const manualUntouched = await seedWorkout(prisma, userId, "MANUAL", "Ride");

    await prisma.$executeRawUnsafe(STRAVA_BACKFILL_SQL);

    expect(await sportOf(prisma, ride)).toBe("cycling");
    expect(await sportOf(prisma, virtualRide)).toBe("cycling");
    expect(await sportOf(prisma, trailRun)).toBe("running");
    expect(await sportOf(prisma, literalWorkout)).toBe("other");
    expect(await sportOf(prisma, unknownArm)).toBe("other");
    expect(await sportOf(prisma, alreadyCanonical)).toBe("running");
    // Source guards.
    expect(await sportOf(prisma, whoopUntouched)).toBe("whoop_sport_1");
    expect(await sportOf(prisma, manualUntouched)).toBe("Ride");
  });

  it("0251 is idempotent — a second apply touches zero rows", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser(prisma, "strava-idem");
    await seedWorkout(prisma, userId, "STRAVA", "Ride");
    await seedWorkout(prisma, userId, "STRAVA", "VirtualRide");
    await seedWorkout(prisma, userId, "STRAVA", "Quidditch");

    const firstAffected = await prisma.$executeRawUnsafe(STRAVA_BACKFILL_SQL);
    expect(firstAffected).toBe(3);

    const secondAffected = await prisma.$executeRawUnsafe(STRAVA_BACKFILL_SQL);
    expect(secondAffected).toBe(0);
  });
});
