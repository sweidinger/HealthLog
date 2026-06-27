import { describe, it, expect, vi, beforeEach } from "vitest";

const { measurement, moodEntry } = vi.hoisted(() => ({
  measurement: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  moodEntry: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: { measurement, moodEntry },
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
  invalidateUserMood: vi.fn(),
}));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeMoodBucketsForEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/moodlog/push", () => ({
  pushMoodEntriesToMoodLog: vi.fn().mockResolvedValue(undefined),
}));

const auditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/auth/audit", () => ({
  auditLog: (...args: unknown[]) => auditLog(...args),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({ addMeta: vi.fn() }),
}));

import { logMcpMeasurement, logMcpMood } from "../writes";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";

beforeEach(() => {
  vi.clearAllMocks();
  measurement.findUnique.mockResolvedValue(null);
  measurement.create.mockResolvedValue({ id: "m-1" });
  moodEntry.findUnique.mockResolvedValue(null);
  moodEntry.create.mockResolvedValue({
    date: "2026-06-27",
    mood: "GUT",
    note: null,
    tags: [],
  });
});

describe("logMcpMeasurement", () => {
  it("writes one row with source MCP for a capturable type", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 80,
      idempotencyKey: "key-1",
    });

    expect(result.status).toBe("written");
    expect(measurement.create).toHaveBeenCalledTimes(1);
    const data = measurement.create.mock.calls[0][0].data;
    expect(data.source).toBe("MCP");
    expect(data.userId).toBe("u-1");
    expect(data.type).toBe("WEIGHT");
    expect(data.value).toBe(80);
    expect(data.unit).toBe("kg");
    // externalId is namespaced + hashed (never the raw key).
    expect(data.externalId).toMatch(/^mcp:measure:[0-9a-f]{64}$/);
    expect(data.externalId).not.toContain("key-1");
    expect(invalidateUserMeasurements).toHaveBeenCalledWith("u-1", {
      evict: true,
    });
    expect(auditLog).toHaveBeenCalledWith(
      "mcp.write.measurement",
      expect.objectContaining({ userId: "u-1" }),
    );
  });

  it("refuses a non-capturable / clinical-only type without writing", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "RECOVERY_SCORE" as never,
      value: 50,
      idempotencyKey: "key-x",
    });
    expect(result.status).toBe("unsupported_type");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range value without writing", async () => {
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 99999,
      idempotencyKey: "key-y",
    });
    expect(result.status).toBe("out_of_range");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("is idempotent — a second call with the same key writes nothing", async () => {
    measurement.findUnique.mockResolvedValue({
      id: "m-1",
      value: 80,
      unit: "kg",
      measuredAt: new Date("2026-06-27T08:00:00Z"),
    });
    const result = await logMcpMeasurement({
      userId: "u-1",
      type: "WEIGHT",
      value: 80,
      idempotencyKey: "key-1",
    });
    expect(result.status).toBe("already_logged");
    expect(measurement.create).not.toHaveBeenCalled();
  });

  it("derives the same externalId for the same idempotencyKey", async () => {
    await logMcpMeasurement({
      userId: "u-1",
      type: "PULSE",
      value: 60,
      idempotencyKey: "stable",
    });
    const first = measurement.create.mock.calls[0][0].data.externalId;
    vi.clearAllMocks();
    measurement.findUnique.mockResolvedValue(null);
    measurement.create.mockResolvedValue({ id: "m-2" });
    await logMcpMeasurement({
      userId: "u-1",
      type: "PULSE",
      value: 61,
      idempotencyKey: "stable",
    });
    const second = measurement.create.mock.calls[0][0].data.externalId;
    expect(first).toBe(second);
  });
});

describe("logMcpMood", () => {
  it("writes one mood row with source MCP", async () => {
    const result = await logMcpMood({
      userId: "u-1",
      score: 4,
      idempotencyKey: "mood-1",
    });
    expect(result.status).toBe("written");
    expect(moodEntry.create).toHaveBeenCalledTimes(1);
    const data = moodEntry.create.mock.calls[0][0].data;
    expect(data.source).toBe("MCP");
    expect(data.userId).toBe("u-1");
    expect(data.externalId).toMatch(/^mcp:mood:[0-9a-f]{64}$/);
    expect(auditLog).toHaveBeenCalledWith(
      "mcp.write.mood",
      expect.objectContaining({ userId: "u-1" }),
    );
  });

  it("rejects an out-of-band score without writing", async () => {
    const result = await logMcpMood({
      userId: "u-1",
      score: 9,
      idempotencyKey: "mood-bad",
    });
    expect(result.status).toBe("invalid_score");
    expect(moodEntry.create).not.toHaveBeenCalled();
  });

  it("is idempotent on the same key", async () => {
    moodEntry.findUnique.mockResolvedValue({
      mood: "GUT",
      score: 4,
      note: null,
      date: "2026-06-27",
    });
    const result = await logMcpMood({
      userId: "u-1",
      score: 4,
      idempotencyKey: "mood-1",
    });
    expect(result.status).toBe("already_logged");
    expect(moodEntry.create).not.toHaveBeenCalled();
  });
});
