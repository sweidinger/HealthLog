import { describe, it, expect, vi, beforeEach } from "vitest";

const { moodEntry } = vi.hoisted(() => ({
  moodEntry: {
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: { moodEntry },
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMood: vi.fn(),
}));

vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeMoodBucketsForEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/moodlog/push", () => ({
  pushMoodEntriesToMoodLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addMeta: vi.fn() }),
}));

import {
  logTelegramMood,
  attachTelegramMoodNote,
} from "@/lib/mood/create-from-telegram";
import { invalidateUserMood } from "@/lib/cache/invalidate";

beforeEach(() => {
  vi.clearAllMocks();
  moodEntry.findUnique.mockResolvedValue(null);
  moodEntry.create.mockResolvedValue({
    id: "mood-1",
    date: "2026-06-21",
    mood: "GUT",
    note: null,
    tags: null,
  });
  moodEntry.updateMany.mockResolvedValue({ count: 1 });
});

describe("logTelegramMood", () => {
  it("maps a 1–5 score to the canonical mood enum and writes source=TELEGRAM", async () => {
    const result = await logTelegramMood({
      userId: "user-1",
      score: 4,
      tz: "Europe/Berlin",
      externalId: "telegram:mood:7777:555:4",
    });

    expect(result.created).toBe(true);
    expect(result.moodEntryId).toBe("mood-1");
    const data = moodEntry.create.mock.calls[0][0].data;
    expect(data.userId).toBe("user-1");
    expect(data.mood).toBe("GUT");
    expect(data.score).toBe(4);
    expect(data.source).toBe("TELEGRAM");
    expect(data.externalId).toBe("telegram:mood:7777:555:4");
    expect(invalidateUserMood).toHaveBeenCalledWith("user-1");
  });

  it("is idempotent on externalId — a redelivered tap does not duplicate", async () => {
    moodEntry.findUnique.mockResolvedValueOnce({ id: "mood-existing" });
    const result = await logTelegramMood({
      userId: "user-1",
      score: 2,
      tz: null,
      externalId: "telegram:mood:7777:555:2",
    });
    expect(result.created).toBe(false);
    expect(result.moodEntryId).toBe("mood-existing");
    expect(moodEntry.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid score", async () => {
    await expect(
      logTelegramMood({
        userId: "user-1",
        score: 7,
        tz: null,
        externalId: "x",
      }),
    ).rejects.toThrow(/Invalid mood score/);
  });
});

describe("attachTelegramMoodNote", () => {
  it("updates the note scoped to the user + entry and busts the cache", async () => {
    const ok = await attachTelegramMoodNote({
      userId: "user-1",
      moodEntryId: "mood-1",
      note: "rough night",
    });
    expect(ok).toBe(true);
    const arg = moodEntry.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      id: "mood-1",
      userId: "user-1",
      deletedAt: null,
    });
    expect(arg.data.note).toBe("rough night");
    expect(invalidateUserMood).toHaveBeenCalledWith("user-1");
  });

  it("returns false when the entry does not belong to the user", async () => {
    moodEntry.updateMany.mockResolvedValueOnce({ count: 0 });
    const ok = await attachTelegramMoodNote({
      userId: "user-1",
      moodEntryId: "foreign",
      note: "x",
    });
    expect(ok).toBe(false);
  });
});
