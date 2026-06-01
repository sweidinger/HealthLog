import { describe, it, expect, vi, beforeEach } from "vitest";

const { recomputeBucketsForMeasurement } = vi.hoisted(() => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement,
}));

import {
  bucketMeanRows,
  consolidateDailyMean,
  meanBucketValue,
} from "../consolidate-daily-mean";
import type { PerSampleRow } from "../drain-per-sample-cumulative";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";

function row(
  id: string,
  value: number,
  iso: string,
  externalId: string | null = null,
  unit = "m/s",
  type: MeasurementType = "WALKING_SPEED",
): PerSampleRow {
  return {
    id,
    type,
    value,
    measuredAt: new Date(iso),
    externalId,
    unit,
  };
}

beforeEach(() => {
  recomputeBucketsForMeasurement.mockClear();
});

describe("consolidate-daily-mean — reducer + bucketing", () => {
  it("computes the arithmetic mean of a per-day bucket", () => {
    const rows = [
      row("a", 1.2, "2026-05-01T08:00:00.000Z"),
      row("b", 1.4, "2026-05-01T09:00:00.000Z"),
      row("c", 1.0, "2026-05-01T10:00:00.000Z"),
    ];
    // (1.2 + 1.4 + 1.0) / 3 = 1.2 — NOT the sum (3.6).
    expect(meanBucketValue(rows)).toBeCloseTo(1.2, 6);
  });

  it("returns 0 for an empty bucket", () => {
    expect(meanBucketValue([])).toBe(0);
  });

  it("buckets per-sample rows by the user's local calendar day", () => {
    const rows = [
      row("a", 1.0, "2026-05-01T08:00:00.000Z"),
      row("b", 2.0, "2026-05-01T20:00:00.000Z"),
      row("c", 3.0, "2026-05-02T06:00:00.000Z"),
    ];
    const byDay = bucketMeanRows(rows, "Europe/Berlin");
    expect(byDay.size).toBe(2);
    expect(byDay.get("2026-05-01")?.length).toBe(2);
    expect(byDay.get("2026-05-02")?.length).toBe(1);
  });

  it("skips rows already in the daily-stats shape (idempotent re-run)", () => {
    const rows = [
      row(
        "stats",
        1.3,
        "2026-05-01T12:00:00.000Z",
        "stats:HKQuantityTypeIdentifierWalkingSpeed:2026-05-01",
      ),
      row("a", 1.1, "2026-05-01T08:00:00.000Z"),
    ];
    const byDay = bucketMeanRows(rows, "Europe/Berlin");
    // Only the raw row enters a bucket; the stats row is never re-folded.
    expect(byDay.get("2026-05-01")?.length).toBe(1);
    expect(byDay.get("2026-05-01")?.[0].id).toBe("a");
  });
});

describe("consolidateDailyMean — drain flow (mocked Prisma)", () => {
  function buildPrismaMock(rowsByType: Record<string, unknown[]>) {
    const upsert = vi.fn().mockResolvedValue({});
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findManyMeasurement = vi.fn(
      async (args: { where: { type: string } }) =>
        rowsByType[args.where.type] ?? [],
    );
    const tx = {
      measurement: { upsert, updateMany },
    };
    return {
      mock: {
        user: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: "user-1", timezone: "Europe/Berlin" }]),
        },
        measurement: { findMany: findManyMeasurement },
        $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) =>
          cb(tx),
        ),
      } as unknown as PrismaClient & {
        measurement: { findMany: ReturnType<typeof vi.fn> };
      },
      upsert,
      updateMany,
      findManyMeasurement,
    };
  }

  it("scopes the scan to APPLE_HEALTH and never scans PULSE", async () => {
    const { mock, findManyMeasurement } = buildPrismaMock({});
    await consolidateDailyMean(mock, { log: () => {} });

    const scannedTypes = findManyMeasurement.mock.calls.map(
      (c) => (c[0] as { where: { type: string } }).where.type,
    );
    expect(scannedTypes).not.toContain("PULSE");
    for (const call of findManyMeasurement.mock.calls) {
      const where = (call[0] as unknown as { where: { source: string } })
        .where;
      expect(where.source).toBe("APPLE_HEALTH");
    }
  });

  it("upserts the per-day mean and soft-deletes the source rows", async () => {
    const walkingSpeedRows = [
      row("a", 1.0, "2026-05-01T08:00:00.000Z"),
      row("b", 1.4, "2026-05-01T09:00:00.000Z"),
    ];
    const { mock, upsert, updateMany } = buildPrismaMock({
      WALKING_SPEED: walkingSpeedRows,
    });

    const summary = await consolidateDailyMean(mock, { log: () => {} });

    // value is the MEAN (1.2), not the sum (2.4).
    const upsertArg = upsert.mock.calls[0]?.[0] as {
      create: { value: number; source: string; unit: string };
    };
    expect(upsertArg.create.value).toBeCloseTo(1.2, 6);
    expect(upsertArg.create.source).toBe("APPLE_HEALTH");
    // Unit is read straight off the day's rows (no separate query).
    expect(upsertArg.create.unit).toBe("m/s");

    // soft-delete: updateMany sets deletedAt, never a hard delete.
    const updArg = updateMany.mock.calls[0]?.[0] as {
      data: { deletedAt: Date };
    };
    expect(updArg.data.deletedAt).toBeInstanceOf(Date);
    expect(summary.totals.daysConsolidated).toBe(1);

    // T3 — the rollup DAY bucket must be recomputed for the touched
    // (user, type, day) so a rollup-covered read does not serve a
    // pre-drain mean derived from the now soft-deleted samples.
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(1);
    const [uid, type, measuredAt] =
      recomputeBucketsForMeasurement.mock.calls[0];
    expect(uid).toBe("user-1");
    expect(type).toBe("WALKING_SPEED");
    expect(measuredAt).toBeInstanceOf(Date);
  });

  it("routes the v1.8.5 gait/mobility types through the drain", async () => {
    const { mock, upsert } = buildPrismaMock({
      WALKING_ASYMMETRY: [
        row("a", 2.0, "2026-05-01T08:00:00.000Z", null, "%", "WALKING_ASYMMETRY"),
        row("b", 4.0, "2026-05-01T09:00:00.000Z", null, "%", "WALKING_ASYMMETRY"),
      ],
      WALKING_HEART_RATE_AVERAGE: [
        row(
          "c",
          90,
          "2026-05-01T08:00:00.000Z",
          null,
          "count/min",
          "WALKING_HEART_RATE_AVERAGE",
        ),
        row(
          "d",
          110,
          "2026-05-01T09:00:00.000Z",
          null,
          "count/min",
          "WALKING_HEART_RATE_AVERAGE",
        ),
      ],
    });

    const summary = await consolidateDailyMean(mock, { log: () => {} });

    // One consolidated daily row per type — the day's MEAN, not the sum.
    const byType = new Map(
      upsert.mock.calls.map((c) => {
        const arg = c[0] as {
          where: { userId_type_source_externalId: { type: string } };
          create: { value: number };
        };
        return [arg.where.userId_type_source_externalId.type, arg.create.value];
      }),
    );
    expect(byType.get("WALKING_ASYMMETRY")).toBeCloseTo(3.0, 6);
    expect(byType.get("WALKING_HEART_RATE_AVERAGE")).toBeCloseTo(100, 6);
    expect(summary.totals.daysConsolidated).toBe(2);
    // Recompute fires once per consolidated (type, day).
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(2);
  });

  it("never scans PULSE even alongside the gait types", async () => {
    const { mock, findManyMeasurement } = buildPrismaMock({});
    await consolidateDailyMean(mock, { log: () => {} });
    const scannedTypes = findManyMeasurement.mock.calls.map(
      (c) => (c[0] as { where: { type: string } }).where.type,
    );
    expect(scannedTypes).toContain("WALKING_ASYMMETRY");
    expect(scannedTypes).toContain("WALKING_STEADINESS");
    expect(scannedTypes).not.toContain("PULSE");
  });

  it("does not recompute on a dry-run", async () => {
    const { mock } = buildPrismaMock({
      WALKING_SPEED: [row("a", 1.0, "2026-05-01T08:00:00.000Z")],
    });
    await consolidateDailyMean(mock, { dryRun: true, log: () => {} });
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
  });

  it("passes the grace cutoff into the scan when cutoffHours is set", async () => {
    const { mock, findManyMeasurement } = buildPrismaMock({});
    await consolidateDailyMean(mock, { cutoffHours: 36, log: () => {} });
    const call = findManyMeasurement.mock.calls[0]?.[0] as unknown as {
      where: { measuredAt?: { lt: Date } };
    };
    expect(call.where.measuredAt?.lt).toBeInstanceOf(Date);
  });
});
