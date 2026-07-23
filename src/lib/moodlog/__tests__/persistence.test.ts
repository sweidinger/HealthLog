import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    moodEntry: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/db";
import { persistMoodLogSourceEntry } from "../persistence";

describe("persistMoodLogSourceEntry concurrent legacy adoption", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("applies the losing replay payload to the row adopted by the winner", async () => {
    const moodLoggedAt = new Date("2026-07-19T08:30:00.000Z");
    vi.mocked(prisma.moodEntry.upsert).mockRejectedValueOnce(
      Object.assign(new Error("natural-key collision"), { code: "P2002" }),
    );
    vi.mocked(prisma.moodEntry.updateMany).mockResolvedValueOnce({
      count: 0,
    });
    vi.mocked(prisma.moodEntry.findUnique).mockResolvedValueOnce({
      date: "2026-07-19",
      moodLoggedAt,
    } as never);
    vi.mocked(prisma.moodEntry.update).mockResolvedValueOnce({} as never);

    await persistMoodLogSourceEntry("user-1", {
      externalId: "provider-event-1",
      date: "2026-07-19",
      moodLoggedAt,
      mood: "SUPER_GUT",
      score: 5,
      tags: ["updated"],
    });

    expect(prisma.moodEntry.update).toHaveBeenCalledWith({
      where: {
        userId_source_externalId: {
          userId: "user-1",
          source: "MOODLOG",
          externalId: "provider-event-1",
        },
      },
      data: {
        mood: "SUPER_GUT",
        score: 5,
        tags: JSON.stringify(["updated"]),
        source: "MOODLOG",
        deletedAt: null,
        date: "2026-07-19",
        moodLoggedAt,
      },
    });
  });
});
