import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  captureHostMetric,
  getHostMetricRetentionDays,
  runHostMetricTick,
  DEFAULT_HOST_METRIC_RETENTION_DAYS,
} from "../host-metric-sampler";

function makePrismaMock() {
  return {
    hostMetric: {
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
    },
  } as unknown as PrismaClient;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.HOST_METRIC_RETENTION_DAYS;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("getHostMetricRetentionDays", () => {
  it("returns 7 days when env is unset", () => {
    expect(getHostMetricRetentionDays()).toBe(
      DEFAULT_HOST_METRIC_RETENTION_DAYS,
    );
  });

  it("respects a valid override", () => {
    process.env.HOST_METRIC_RETENTION_DAYS = "14";
    expect(getHostMetricRetentionDays()).toBe(14);
  });

  it("ignores nonsensical values (NaN, 0, negative)", () => {
    process.env.HOST_METRIC_RETENTION_DAYS = "0";
    expect(getHostMetricRetentionDays()).toBe(
      DEFAULT_HOST_METRIC_RETENTION_DAYS,
    );
    process.env.HOST_METRIC_RETENTION_DAYS = "-100";
    expect(getHostMetricRetentionDays()).toBe(
      DEFAULT_HOST_METRIC_RETENTION_DAYS,
    );
    process.env.HOST_METRIC_RETENTION_DAYS = "not a number";
    expect(getHostMetricRetentionDays()).toBe(
      DEFAULT_HOST_METRIC_RETENTION_DAYS,
    );
  });
});

describe("captureHostMetric", () => {
  it("returns load + memory fields and forwards disk-stats output", async () => {
    const sample = await captureHostMetric(async () => ({
      readBytes: BigInt(12345),
      writeBytes: BigInt(67890),
    }));

    expect(typeof sample.loadAvg1).toBe("number");
    expect(typeof sample.loadAvg5).toBe("number");
    expect(typeof sample.loadAvg15).toBe("number");
    // Two-decimal precision keeps Postgres rows compact.
    expect(sample.loadAvg1).toBe(Math.round(sample.loadAvg1 * 100) / 100);

    expect(typeof sample.memUsedBytes).toBe("bigint");
    expect(typeof sample.memTotalBytes).toBe("bigint");
    expect(sample.memTotalBytes).toBeGreaterThan(BigInt(0));
    expect(sample.memUsedBytes).toBeLessThanOrEqual(sample.memTotalBytes);

    expect(sample.diskReadBytes).toBe(BigInt(12345));
    expect(sample.diskWriteBytes).toBe(BigInt(67890));
  });

  it("returns null disk fields when the diskstats reader returns null", async () => {
    const sample = await captureHostMetric(async () => null);

    expect(sample.diskReadBytes).toBeNull();
    expect(sample.diskWriteBytes).toBeNull();
  });

  it("returns null disk fields when the diskstats reader throws", async () => {
    const sample = await captureHostMetric(async () => {
      throw new Error("EACCES /proc/diskstats");
    });

    expect(sample.diskReadBytes).toBeNull();
    expect(sample.diskWriteBytes).toBeNull();
  });
});

describe("runHostMetricTick", () => {
  it("inserts a sample row and prunes expired rows", async () => {
    const prisma = makePrismaMock();
    const now = new Date("2026-05-09T12:00:00Z");

    const result = await runHostMetricTick(prisma, {
      now,
      captureFn: async () => ({
        loadAvg1: 0.42,
        loadAvg5: 0.55,
        loadAvg15: 0.61,
        memUsedBytes: BigInt(4_000_000_000),
        memTotalBytes: BigInt(8_000_000_000),
        diskReadBytes: BigInt(1_000),
        diskWriteBytes: BigInt(2_000),
      }),
    });

    expect(result).toEqual({ inserted: 1, pruned: 3 });

    expect(prisma.hostMetric.create).toHaveBeenCalledTimes(1);
    expect(prisma.hostMetric.create).toHaveBeenCalledWith({
      data: {
        capturedAt: now,
        loadAvg1: 0.42,
        loadAvg5: 0.55,
        loadAvg15: 0.61,
        memUsedBytes: BigInt(4_000_000_000),
        memTotalBytes: BigInt(8_000_000_000),
        diskReadBytes: BigInt(1_000),
        diskWriteBytes: BigInt(2_000),
      },
    });

    // 7-day cutoff by default.
    const expectedCutoff = new Date(now.getTime() - 7 * 86_400_000);
    expect(prisma.hostMetric.deleteMany).toHaveBeenCalledWith({
      where: { capturedAt: { lt: expectedCutoff } },
    });
  });

  it("respects HOST_METRIC_RETENTION_DAYS for the prune cutoff", async () => {
    process.env.HOST_METRIC_RETENTION_DAYS = "14";
    const prisma = makePrismaMock();
    const now = new Date("2026-05-09T12:00:00Z");

    await runHostMetricTick(prisma, {
      now,
      captureFn: async () => ({
        loadAvg1: 0,
        loadAvg5: 0,
        loadAvg15: 0,
        memUsedBytes: BigInt(1),
        memTotalBytes: BigInt(2),
        diskReadBytes: null,
        diskWriteBytes: null,
      }),
    });

    const expectedCutoff = new Date(now.getTime() - 14 * 86_400_000);
    expect(prisma.hostMetric.deleteMany).toHaveBeenCalledWith({
      where: { capturedAt: { lt: expectedCutoff } },
    });
  });
});
