import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  cleanupOldCoachMessages,
  getCoachMessageRetentionDays,
  DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
} from "../coach-message-cleanup";

function makePrismaMock(deletedCount: number) {
  return {
    coachMessage: {
      deleteMany: vi.fn().mockResolvedValue({ count: deletedCount }),
    },
  } as unknown as PrismaClient;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.COACH_MESSAGE_RETENTION_DAYS;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("getCoachMessageRetentionDays", () => {
  it("returns 365 when env is unset", () => {
    expect(getCoachMessageRetentionDays()).toBe(
      DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
    );
  });

  it("respects a valid override", () => {
    process.env.COACH_MESSAGE_RETENTION_DAYS = "180";
    expect(getCoachMessageRetentionDays()).toBe(180);
  });

  it("ignores nonsensical values (NaN, 0, negative)", () => {
    process.env.COACH_MESSAGE_RETENTION_DAYS = "0";
    expect(getCoachMessageRetentionDays()).toBe(
      DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
    );
    process.env.COACH_MESSAGE_RETENTION_DAYS = "-100";
    expect(getCoachMessageRetentionDays()).toBe(
      DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
    );
    process.env.COACH_MESSAGE_RETENTION_DAYS = "not a number";
    expect(getCoachMessageRetentionDays()).toBe(
      DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
    );
  });

  it("rejects too-short retention (< 30 days) to protect live history", () => {
    process.env.COACH_MESSAGE_RETENTION_DAYS = "7";
    expect(getCoachMessageRetentionDays()).toBe(
      DEFAULT_COACH_MESSAGE_RETENTION_DAYS,
    );
  });
});

describe("cleanupOldCoachMessages", () => {
  it("deletes coach messages older than 365 days by default", async () => {
    const prisma = makePrismaMock(42);
    const now = new Date("2026-05-04T00:00:00Z");
    const deleted = await cleanupOldCoachMessages(prisma, now);

    expect(deleted).toBe(42);
    expect(prisma.coachMessage.deleteMany).toHaveBeenCalledTimes(1);
    const cutoff = new Date(now.getTime() - 365 * 86_400_000);
    expect(prisma.coachMessage.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
    });
  });

  it("uses the configured retention", async () => {
    process.env.COACH_MESSAGE_RETENTION_DAYS = "90";
    const prisma = makePrismaMock(7);
    const now = new Date("2026-05-04T00:00:00Z");
    await cleanupOldCoachMessages(prisma, now);

    const cutoff = new Date(now.getTime() - 90 * 86_400_000);
    expect(prisma.coachMessage.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
    });
  });
});
