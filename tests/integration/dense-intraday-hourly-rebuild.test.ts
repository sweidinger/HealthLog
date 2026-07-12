/**
 * v1.28.31 — real-Postgres integration coverage for
 * `runDenseIntradayHourlyRebuild()`: converts a pre-hourly folded day
 * (live daily `stats:` row + tombstoned raw rows) to the hourly grain.
 *
 * Pins against live unique indexes: the hourly mints coexist with the
 * daily row (different instants, different externalIds), the daily row is
 * retired in the SAME transaction as the hourly mint (no live overlap →
 * no double count for an AVG-over-live-rows reader), a re-run converges
 * to zero work, days without tombstones keep their daily row, and days
 * inside the retention window are untouched.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { runDenseIntradayHourlyRebuild } from "@/lib/measurements/dense-intraday-hourly-rebuild";
import { findHourlyRebuildCandidateUserIds } from "@/lib/jobs/dense-intraday-hourly-rebuild";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";

const TEST_USER_ID = "user-hourly-rebuild";
const TZ = "Europe/Berlin";
const DAY_KEY = "2026-05-01";
const CANONICAL = canonicalDailyTimestamp(DAY_KEY, TZ);
const HRV_HK = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
const HRV_DAILY_STATS_ID = `stats:${HRV_HK}:${DAY_KEY}`;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "hourly-rebuild",
      email: "hourly-rebuild@example.test",
      timezone: TZ,
    },
  });
});

/** Seed the exact shape the pre-hourly fold left behind for one HRV day. */
async function seedFoldedDay(): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.measurement.create({
    data: {
      userId: TEST_USER_ID,
      type: "HEART_RATE_VARIABILITY",
      value: 50, // the old daily mean of (40, 60)
      unit: "ms",
      source: "APPLE_HEALTH",
      measuredAt: CANONICAL,
      externalId: HRV_DAILY_STATS_ID,
    },
  });
  await prisma.measurement.createMany({
    data: [
      {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 40,
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-01T08:00:00.000Z"), // local hour 10
        externalId: "hk-hrv-1",
        deletedAt: new Date("2026-05-15T02:00:00.000Z"), // fold tombstone
      },
      {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 60,
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-01T09:00:00.000Z"), // local hour 11
        externalId: "hk-hrv-2",
        deletedAt: new Date("2026-05-15T02:00:00.000Z"),
      },
    ],
  });
}

describe("runDenseIntradayHourlyRebuild (real Postgres)", () => {
  it("rebuilds hourly means from the tombstones and retires the daily row atomically", async () => {
    const prisma = getPrismaClient();
    await seedFoldedDay();

    const summary = await runDenseIntradayHourlyRebuild(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });

    expect(summary.totals.daysRebuilt).toBe(1);
    expect(summary.totals.hourlyRowsUpserted).toBe(2);
    expect(summary.totals.dailyRowsRetired).toBe(1);
    expect(summary.totals.daysFailed).toBe(0);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
      orderBy: { measuredAt: "asc" },
    });
    // ONLY the hourly rows are live — never the daily row alongside them.
    expect(live).toHaveLength(2);
    expect(live.map((r) => r.externalId)).toEqual([
      `stats:${HRV_HK}:${DAY_KEY}T10`,
      `stats:${HRV_HK}:${DAY_KEY}T11`,
    ]);
    expect(live.map((r) => r.value)).toEqual([40, 60]);
    expect(live.map((r) => r.measuredAt.toISOString())).toEqual([
      "2026-05-01T08:30:00.000Z",
      "2026-05-01T09:30:00.000Z",
    ]);

    // The daily row is tombstoned, and the raw tombstones stayed tombstoned
    // (the rebuild reads them, never resurrects them).
    const daily = await prisma.measurement.findFirst({
      where: { userId: TEST_USER_ID, externalId: HRV_DAILY_STATS_ID },
    });
    expect(daily?.deletedAt).not.toBeNull();
    const rawTombstones = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        externalId: { in: ["hk-hrv-1", "hk-hrv-2"] },
      },
    });
    expect(rawTombstones.every((r) => r.deletedAt !== null)).toBe(true);
  });

  it("re-run converges to zero work (the retired daily row IS the marker)", async () => {
    const prisma = getPrismaClient();
    await seedFoldedDay();

    const first = await runDenseIntradayHourlyRebuild(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(first.totals.daysRebuilt).toBe(1);

    const second = await runDenseIntradayHourlyRebuild(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(second.totals.daysRebuilt).toBe(0);
    expect(second.totals.hourlyRowsUpserted).toBe(0);
    expect(second.totals.dailyRowsRetired).toBe(0);
    expect(second.totals.daysSkippedNoTombstones).toBe(0);

    // The hourly rows are unchanged by the second pass.
    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
      orderBy: { measuredAt: "asc" },
    });
    expect(live.map((r) => r.value)).toEqual([40, 60]);
  });

  it("keeps the daily row for days whose tombstones were pruned (nothing to reconstruct)", async () => {
    const prisma = getPrismaClient();
    // Daily row only — the raw tombstones were hard-deleted by the
    // tombstone-retention prune long ago.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 50,
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: CANONICAL,
        externalId: HRV_DAILY_STATS_ID,
      },
    });

    const summary = await runDenseIntradayHourlyRebuild(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });

    expect(summary.totals.daysRebuilt).toBe(0);
    expect(summary.totals.daysSkippedNoTombstones).toBe(1);

    const daily = await prisma.measurement.findFirst({
      where: { userId: TEST_USER_ID, externalId: HRV_DAILY_STATS_ID },
    });
    // Untouched and still live — it is the day's only representation.
    expect(daily?.deletedAt).toBeNull();
    expect(daily?.value).toBeCloseTo(50, 6);
  });

  it("never touches days inside the retention window", async () => {
    const prisma = getPrismaClient();
    // A daily row anchored 2 days ago — inside the default 14-day window.
    // (Synthetic: the real fold never produces one this recent, but the
    // window bound must hold regardless of how the row got there.)
    const recentNoon = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const recentDayKey = recentNoon.toISOString().slice(0, 10);
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 50,
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: recentNoon,
        externalId: `stats:${HRV_HK}:${recentDayKey}`,
      },
    });
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 40,
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: new Date(recentNoon.getTime() - 60 * 60 * 1000),
        externalId: "hk-hrv-recent",
        deletedAt: new Date(),
      },
    });

    const summary = await runDenseIntradayHourlyRebuild(prisma, {
      userId: TEST_USER_ID,
      // Default retention window.
      log: () => {},
    });

    expect(summary.totals.daysRebuilt).toBe(0);
    const daily = await prisma.measurement.findFirst({
      where: {
        userId: TEST_USER_ID,
        externalId: `stats:${HRV_HK}:${recentDayKey}`,
      },
    });
    expect(daily?.deletedAt).toBeNull();
  });

  it("never touches non-APPLE_HEALTH sources", async () => {
    const prisma = getPrismaClient();
    // A Withings daily-shaped row + a tombstoned Withings raw row must both
    // survive untouched — every rebuild predicate is source-scoped.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 48,
        unit: "ms",
        source: "WITHINGS",
        measuredAt: CANONICAL,
        externalId: HRV_DAILY_STATS_ID,
      },
    });
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 44,
        unit: "ms",
        source: "WITHINGS",
        measuredAt: new Date("2026-05-01T08:00:00.000Z"),
        externalId: "withings-hrv-1",
        deletedAt: new Date(),
      },
    });

    const summary = await runDenseIntradayHourlyRebuild(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });

    expect(summary.totals.daysRebuilt).toBe(0);
    const withingsDaily = await prisma.measurement.findFirst({
      where: { userId: TEST_USER_ID, source: "WITHINGS", deletedAt: null },
    });
    expect(withingsDaily?.value).toBeCloseTo(48, 6);
  });
});

describe("findHourlyRebuildCandidateUserIds (boot-discovery SQL, real Postgres)", () => {
  // Discovery bound "older than now" so the seeded 2026-05-01 day is in scope.
  const WINDOW_START = new Date();

  it("finds a user with a folded day (live daily row + paired tombstones)", async () => {
    await seedFoldedDay();
    const users = await findHourlyRebuildCandidateUserIds(
      getPrismaClient(),
      WINDOW_START,
    );
    expect(users).toEqual([TEST_USER_ID]);
  });

  it("converges: after the rebuild the pairing no longer matches", async () => {
    const prisma = getPrismaClient();
    await seedFoldedDay();
    await runDenseIntradayHourlyRebuild(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    const users = await findHourlyRebuildCandidateUserIds(prisma, WINDOW_START);
    // The retired daily row is the durable marker — zero candidates left,
    // so the boot discovery enqueues nothing on every later boot.
    expect(users).toEqual([]);
  });

  it("ignores a daily row without tombstoned raws, and hourly-shaped rows", async () => {
    const prisma = getPrismaClient();
    // Daily row alone (tombstones pruned) — no pair.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 50,
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: CANONICAL,
        externalId: HRV_DAILY_STATS_ID,
      },
    });
    // Hourly-grain row + a tombstoned raw in its window — the hourly
    // externalId shape must not qualify as a daily candidate.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "PULSE",
        value: 60,
        unit: "bpm",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-02T08:30:00.000Z"),
        externalId: "stats:HKQuantityTypeIdentifierHeartRate:2026-05-02T10",
      },
    });
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "PULSE",
        value: 62,
        unit: "bpm",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-02T08:00:00.000Z"),
        externalId: "hk-pulse-raw",
        deletedAt: new Date(),
      },
    });

    const users = await findHourlyRebuildCandidateUserIds(prisma, WINDOW_START);
    expect(users).toEqual([]);
  });

  it("ignores days inside the retention window (windowStart bound)", async () => {
    await seedFoldedDay();
    // A window start BEFORE the seeded day excludes it.
    const users = await findHourlyRebuildCandidateUserIds(
      getPrismaClient(),
      new Date("2026-04-01T00:00:00.000Z"),
    );
    expect(users).toEqual([]);
  });
});
