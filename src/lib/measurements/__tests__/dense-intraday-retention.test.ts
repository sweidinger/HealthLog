/**
 * v1.10.0 — computed scores (WX-E). Dense intra-day retention drain.
 *
 * Pins the retention BOUND: the scan only folds per-sample dense-tier rows
 * OLDER than the retention window (`measuredAt < now - retentionDays`), so
 * the recent intra-day shape the Stress engine reads is never collapsed.
 * Also pins the dense-tier scope (HRV + PULSE), the APPLE_HEALTH source
 * scope, the MEAN reduction + soft-delete, and the rollup recompute.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { recomputeBucketsForMeasurement } = vi.hoisted(() => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement,
}));

import {
  runDenseIntradayRetention,
  DENSE_INTRADAY_RETENTION_DAYS,
  DENSE_INTRADAY_RETENTION_TYPES,
} from "../dense-intraday-retention";
import type { PerSampleRow } from "../drain-per-sample-cumulative";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";

function row(
  id: string,
  value: number,
  iso: string,
  type: MeasurementType,
  unit = "ms",
  externalId: string | null = null,
): PerSampleRow {
  return { id, type, value, measuredAt: new Date(iso), externalId, unit };
}

function buildPrismaMock(rowsByType: Record<string, unknown[]>) {
  const upsert = vi.fn().mockResolvedValue({});
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const findManyMeasurement = vi.fn(
    async (args: { where: { type: string } }) =>
      rowsByType[args.where.type] ?? [],
  );
  const tx = { measurement: { upsert, updateMany } };
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
    } as unknown as PrismaClient,
    upsert,
    updateMany,
    findManyMeasurement,
  };
}

beforeEach(() => {
  recomputeBucketsForMeasurement.mockClear();
});

describe("runDenseIntradayRetention — retention bound", () => {
  it("only scans rows OLDER than the retention window", async () => {
    const { mock, findManyMeasurement } = buildPrismaMock({});
    await runDenseIntradayRetention(mock, { log: () => {} });

    // Every scan carries a `measuredAt < cutoff` predicate — the retention
    // boundary. Without it, in-window intra-day samples would be folded and
    // the Stress engine would lose its shape.
    for (const call of findManyMeasurement.mock.calls) {
      const where = (call[0] as unknown as { where: { measuredAt?: { lt: Date } } })
        .where;
      expect(where.measuredAt?.lt).toBeInstanceOf(Date);
    }
    // The cutoff is ~DENSE_INTRADAY_RETENTION_DAYS in the past.
    const firstCutoff = (
      findManyMeasurement.mock.calls[0]?.[0] as unknown as {
        where: { measuredAt: { lt: Date } };
      }
    ).where.measuredAt.lt.getTime();
    const expected =
      Date.now() - DENSE_INTRADAY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    // Within a generous 60s of the expected boundary.
    expect(Math.abs(firstCutoff - expected)).toBeLessThan(60_000);
  });

  it("folds everything when retentionDays = 0 (no window)", async () => {
    const { mock, findManyMeasurement } = buildPrismaMock({});
    await runDenseIntradayRetention(mock, { retentionDays: 0, log: () => {} });
    for (const call of findManyMeasurement.mock.calls) {
      const where = (call[0] as unknown as { where: { measuredAt?: { lt: Date } } })
        .where;
      // No cutoff predicate → the whole history is in scope.
      expect(where.measuredAt).toBeUndefined();
    }
  });

  it("scans exactly the dense-tier types, source-scoped to APPLE_HEALTH", async () => {
    const { mock, findManyMeasurement } = buildPrismaMock({});
    await runDenseIntradayRetention(mock, { log: () => {} });

    const scannedTypes = findManyMeasurement.mock.calls.map(
      (c) => (c[0] as { where: { type: string } }).where.type,
    );
    expect(scannedTypes.sort()).toEqual(
      Array.from(DENSE_INTRADAY_RETENTION_TYPES).sort(),
    );
    for (const call of findManyMeasurement.mock.calls) {
      const where = (call[0] as unknown as { where: { source: string } }).where;
      expect(where.source).toBe("APPLE_HEALTH");
    }
  });
});

describe("runDenseIntradayRetention — fold flow", () => {
  it("upserts the day MEAN and soft-deletes the out-of-window rows", async () => {
    // Two HRV samples on an out-of-window day.
    const hrvRows = [
      row("a", 40, "2026-05-01T08:00:00.000Z", "HEART_RATE_VARIABILITY"),
      row("b", 60, "2026-05-01T09:00:00.000Z", "HEART_RATE_VARIABILITY"),
    ];
    const { mock, upsert, updateMany } = buildPrismaMock({
      HEART_RATE_VARIABILITY: hrvRows,
    });

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    const upsertArg = upsert.mock.calls[0]?.[0] as {
      create: { value: number; source: string; type: string };
    };
    // value is the MEAN (50), not the sum (100).
    expect(upsertArg.create.value).toBeCloseTo(50, 6);
    expect(upsertArg.create.source).toBe("APPLE_HEALTH");
    expect(upsertArg.create.type).toBe("HEART_RATE_VARIABILITY");

    // soft-delete, never hard delete.
    const updArg = updateMany.mock.calls[0]?.[0] as {
      data: { deletedAt: Date };
    };
    expect(updArg.data.deletedAt).toBeInstanceOf(Date);
    expect(summary.totals.daysConsolidated).toBe(1);
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(1);
  });

  it("does not write on a dry-run", async () => {
    const { mock, upsert } = buildPrismaMock({
      HEART_RATE_VARIABILITY: [
        row("a", 40, "2026-05-01T08:00:00.000Z", "HEART_RATE_VARIABILITY"),
      ],
    });
    await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      dryRun: true,
      log: () => {},
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
  });
});
