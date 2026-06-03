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

function buildPrismaMock(
  rowsByType: Record<string, unknown[]>,
  // When set, the canonical-row lookup inside `writeDay` resolves to this
  // existing row id — simulating a daily row already sitting on the
  // canonical local-noon instant (the P2002 coexistence case).
  existingCanonicalId: string | null = null,
) {
  const create = vi.fn().mockResolvedValue({ id: "minted-daily" });
  const update = vi.fn().mockResolvedValue({});
  const findFirst = vi
    .fn()
    .mockResolvedValue(
      existingCanonicalId ? { id: existingCanonicalId } : null,
    );
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const findManyMeasurement = vi.fn(
    async (args: { where: { type: string } }) =>
      rowsByType[args.where.type] ?? [],
  );
  const tx = { measurement: { create, update, findFirst, updateMany } };
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
    create,
    update,
    findFirst,
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
  it("creates the day MEAN and soft-deletes the out-of-window rows when no canonical row exists", async () => {
    // Two HRV samples on an out-of-window day.
    const hrvRows = [
      row("a", 40, "2026-05-01T08:00:00.000Z", "HEART_RATE_VARIABILITY"),
      row("b", 60, "2026-05-01T09:00:00.000Z", "HEART_RATE_VARIABILITY"),
    ];
    const { mock, create, update, updateMany } = buildPrismaMock({
      HEART_RATE_VARIABILITY: hrvRows,
    });

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    // No pre-existing canonical row → create, not update.
    expect(update).not.toHaveBeenCalled();
    const createArg = create.mock.calls[0]?.[0] as {
      data: { value: number; source: string; type: string };
    };
    // value is the MEAN (50), not the sum (100).
    expect(createArg.data.value).toBeCloseTo(50, 6);
    expect(createArg.data.source).toBe("APPLE_HEALTH");
    expect(createArg.data.type).toBe("HEART_RATE_VARIABILITY");

    // soft-delete, never hard delete.
    const updArg = updateMany.mock.calls[0]?.[0] as {
      data: { deletedAt: Date };
    };
    expect(updArg.data.deletedAt).toBeInstanceOf(Date);
    expect(summary.totals.daysConsolidated).toBe(1);
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(1);
  });

  it("adopts an existing canonical row in place instead of colliding (P2002 coexistence)", async () => {
    const hrvRows = [
      row("a", 40, "2026-05-01T08:00:00.000Z", "HEART_RATE_VARIABILITY"),
      row("b", 60, "2026-05-01T09:00:00.000Z", "HEART_RATE_VARIABILITY"),
    ];
    // A daily row already sits on the canonical local-noon instant.
    const { mock, create, update, updateMany } = buildPrismaMock(
      { HEART_RATE_VARIABILITY: hrvRows },
      "existing-canonical-row",
    );

    await runDenseIntradayRetention(mock, { retentionDays: 0, log: () => {} });

    // The fold adopts the existing row in place — no create (which would
    // collide on the measured_at unique index), an update with the stats
    // externalId + refreshed mean.
    expect(create).not.toHaveBeenCalled();
    const updateArg = update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { value: number; externalId: string; deletedAt: null };
    };
    expect(updateArg.where.id).toBe("existing-canonical-row");
    expect(updateArg.data.value).toBeCloseTo(50, 6);
    expect(updateArg.data.externalId.startsWith("stats:")).toBe(true);
    expect(updateArg.data.deletedAt).toBeNull();

    // The soft-delete excludes the adopted canonical row id.
    const updManyArg = updateMany.mock.calls[0]?.[0] as {
      where: { id: { not: string } };
    };
    expect(updManyArg.where.id.not).toBe("existing-canonical-row");
  });

  it("does not write on a dry-run", async () => {
    const { mock, create, update } = buildPrismaMock({
      HEART_RATE_VARIABILITY: [
        row("a", 40, "2026-05-01T08:00:00.000Z", "HEART_RATE_VARIABILITY"),
      ],
    });
    await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      dryRun: true,
      log: () => {},
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
  });
});
