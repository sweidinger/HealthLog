/**
 * v1.10.2 — real-Postgres integration coverage for
 * `runDenseIntradayRetention()`. The mocked unit tests could not surface
 * the v1.10.0.2 P2002 fold-coexistence bug: the fold mints a canonical
 * daily-mean row at the user's local-noon instant, but a row may ALREADY
 * sit on that `(userId, type, measuredAt, source, sleepStage)` unique
 * index from another path. An externalId-keyed upsert misses the lookup
 * and the INSERT then violates the measured_at index with P2002.
 *
 * This file seeds that exact colliding shape against a live Postgres and
 * asserts the reworked fold coexists with the pre-existing daily row,
 * stays idempotent, and preserves the dense-tier scope.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { runDenseIntradayRetention } from "@/lib/measurements/dense-intraday-retention";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";

const TEST_USER_ID = "user-dense-retention";
const TZ = "Europe/Berlin";
const DAY_KEY = "2026-05-01";
// The canonical local-noon instant the fold writes for the seeded day.
const CANONICAL = canonicalDailyTimestamp(DAY_KEY, TZ);
const HRV_STATS_ID =
  "stats:HKQuantityTypeIdentifierHeartRateVariabilitySDNN:2026-05-01";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "dense-retention",
      email: "dense-retention@example.test",
      timezone: TZ,
    },
  });
});

describe("runDenseIntradayRetention (real Postgres)", () => {
  it("folds out-of-window HRV per-sample rows into one daily MEAN and soft-deletes them", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 40,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T08:00:00.000Z"),
          externalId: "hk-hrv-1",
        },
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 60,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T09:00:00.000Z"),
          externalId: "hk-hrv-2",
        },
      ],
    });

    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });

    expect(summary.totals.daysConsolidated).toBe(1);
    expect(summary.totals.perSampleRowsSoftDeleted).toBe(2);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
    });
    expect(live).toHaveLength(1);
    // MEAN of (40, 60) = 50.
    expect(live[0].value).toBeCloseTo(50, 6);
    expect(live[0].externalId).toBe(HRV_STATS_ID);
    expect(live[0].measuredAt.getTime()).toBe(CANONICAL.getTime());
  });

  it("coexists with a pre-existing daily row on the canonical instant (the P2002 case)", async () => {
    const prisma = getPrismaClient();
    // A previously-collapsed daily `stats:` row ALREADY sits on the
    // canonical local-noon instant under a DIFFERENT HK stats id than the
    // one the fold mints (e.g. a row minted by a sibling consolidation path,
    // or a legacy stats id). The scan EXCLUDES it (NOT startsWith 'stats:'),
    // so it is never folded into the mean — but pre-v1.10.2 the fold's
    // externalId-keyed upsert missed it on lookup and the INSERT then
    // collided on (userId, type, measuredAt, source, sleepStage) with P2002.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 999, // stale value to be overwritten by the fold
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: CANONICAL,
        externalId: "stats:legacy-hrv-id:2026-05-01",
      },
    });
    // Out-of-window per-sample rows that should fold into the canonical row.
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 40,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T06:00:00.000Z"),
          externalId: "hk-hrv-1",
        },
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 60,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T18:00:00.000Z"),
          externalId: "hk-hrv-2",
        },
      ],
    });

    // Must not throw P2002.
    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(summary.totals.daysConsolidated).toBe(1);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
    });
    // Exactly one live daily row: the pre-existing one, adopted in place.
    expect(live).toHaveLength(1);
    expect(live[0].measuredAt.getTime()).toBe(CANONICAL.getTime());
    // The fold refreshed the value to the per-sample MEAN (50), overwriting
    // the stale 999, and stamped the canonical `stats:` externalId.
    expect(live[0].value).toBeCloseTo(50, 6);
    expect(live[0].externalId).toBe(HRV_STATS_ID);

    // The two out-of-window samples are tombstoned.
    const tombstoned = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: { not: null },
      },
    });
    expect(tombstoned).toHaveLength(2);
  });

  it("adopts the row already carrying the target stats externalId on the canonical instant (VECTOR 1)", async () => {
    const prisma = getPrismaClient();
    // BOTH-present collision (VECTOR 1). A prior fold already minted the
    // canonical daily row carrying the TARGET `stats:` externalId and it
    // sits on the canonical local-noon instant. A fresh batch of
    // out-of-window per-sample rows then arrives for the same day. The fold
    // must adopt the EXISTING canonical row in place — refreshing its value
    // and re-anchoring it — never INSERT a second row at local-noon (that
    // would collide on the measured_at composite) and never stamp the target
    // externalId onto a sibling (that would collide on the externalId
    // composite with this very row). The pre-fix `findFirst` had no
    // externalId discrimination and no deterministic `orderBy`, so it could
    // pick the wrong row and trip P2002 on the externalId index.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 999, // stale — the fold overwrites it with the day's mean
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: CANONICAL,
        externalId: HRV_STATS_ID, // the TARGET canonical externalId
      },
    });
    // Out-of-window per-sample rows that fold into the canonical row.
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 40,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T06:00:00.000Z"),
          externalId: "hk-hrv-1",
        },
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 60,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T18:00:00.000Z"),
          externalId: "hk-hrv-2",
        },
      ],
    });

    // Must not throw P2002.
    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(summary.totals.daysConsolidated).toBe(1);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
    });
    // Exactly ONE live canonical row remains — the row that already carried
    // the target `stats:` externalId, adopted in place and folded.
    expect(live).toHaveLength(1);
    expect(live[0].externalId).toBe(HRV_STATS_ID);
    expect(live[0].measuredAt.getTime()).toBe(CANONICAL.getTime());
    // MEAN of the two folded per-sample values (40, 60) = 50, overwriting
    // the stale 999.
    expect(live[0].value).toBeCloseTo(50, 6);

    // Both scanned per-sample rows are tombstoned.
    const tombstoned = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: { not: null },
      },
    });
    expect(tombstoned).toHaveLength(2);
  });

  it("does not tombstone a per-sample row that happens to fall on the canonical instant", async () => {
    const prisma = getPrismaClient();
    // One per-sample row sits exactly on the canonical local-noon instant;
    // it must become the adopted daily row, not get soft-deleted.
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 50,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: CANONICAL,
          externalId: "hk-hrv-noon",
        },
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 70,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T06:00:00.000Z"),
          externalId: "hk-hrv-morning",
        },
      ],
    });

    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(summary.totals.daysConsolidated).toBe(1);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
    });
    expect(live).toHaveLength(1);
    expect(live[0].measuredAt.getTime()).toBe(CANONICAL.getTime());
    // MEAN of (50, 70) = 60 — the adopted row carries the day's mean.
    expect(live[0].value).toBeCloseTo(60, 6);
    expect(live[0].externalId).toBe(HRV_STATS_ID);
  });

  it("is idempotent — a second run is a no-op and the value stays correct", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 60,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T06:00:00.000Z"),
          externalId: "hk-pulse-1",
        },
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 80,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T18:00:00.000Z"),
          externalId: "hk-pulse-2",
        },
      ],
    });

    const first = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(first.totals.daysConsolidated).toBe(1);
    expect(first.totals.perSampleRowsSoftDeleted).toBe(2);

    // Second run must converge to zero work and never collide on the
    // canonical row it minted on the first pass.
    const second = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(second.totals.daysConsolidated).toBe(0);
    expect(second.totals.perSampleRowsSoftDeleted).toBe(0);

    const live = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "PULSE", deletedAt: null },
    });
    expect(live).toHaveLength(1);
    // MEAN of (60, 80) = 70.
    expect(live[0].value).toBeCloseTo(70, 6);
  });

  it("keeps in-window per-sample rows raw (retention bound)", async () => {
    const prisma = getPrismaClient();
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 45,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: recent,
          externalId: "hk-hrv-recent-1",
        },
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 55,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date(recent.getTime() + 60 * 60 * 1000),
          externalId: "hk-hrv-recent-2",
        },
      ],
    });

    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      // Default 14-day window — both rows are inside it.
      log: () => {},
    });
    expect(summary.totals.daysConsolidated).toBe(0);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
    });
    // Both raw samples survive — the intra-day shape is preserved.
    expect(live).toHaveLength(2);
  });
});
