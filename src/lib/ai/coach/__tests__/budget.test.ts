import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { HttpError } from "@/lib/api-handler";
import { buildDateKey, MAX_TOKENS_PER_USER_PER_DAY } from "../budget";

vi.mock("@/lib/db", () => ({
  prisma: {
    coachUsage: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

describe("buildDateKey", () => {
  it("formats UTC YYYY-MM-DD", () => {
    // 2026-05-10T22:30Z is UTC May 10 — Berlin would be May 11 already
    const key = buildDateKey(new Date("2026-05-10T22:30:00.000Z"));
    expect(key).toBe("2026-05-10");
  });

  it("rolls forward at UTC midnight", () => {
    const key = buildDateKey(new Date("2026-05-11T00:01:00.000Z"));
    expect(key).toBe("2026-05-11");
  });
});

describe("budget", () => {
  let prismaMock: {
    coachUsage: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    const dbModule = await import("@/lib/db");
    prismaMock = dbModule.prisma as unknown as typeof prismaMock;
    prismaMock.coachUsage.findUnique.mockReset();
    prismaMock.coachUsage.upsert.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 0 when no usage row exists", async () => {
    prismaMock.coachUsage.findUnique.mockResolvedValue(null);
    const { getDailyTokenSpend } = await import("../budget");
    const spent = await getDailyTokenSpend("user-1", "2026-05-10");
    expect(spent).toBe(0);
  });

  it("returns the persisted token total", async () => {
    prismaMock.coachUsage.findUnique.mockResolvedValue({ totalTokens: 4_200 });
    const { getDailyTokenSpend } = await import("../budget");
    const spent = await getDailyTokenSpend("user-1", "2026-05-10");
    expect(spent).toBe(4_200);
  });

  it("under-budget passes enforceBudget without throwing", async () => {
    prismaMock.coachUsage.findUnique.mockResolvedValue({ totalTokens: 5_000 });
    const { enforceBudget } = await import("../budget");
    await expect(
      enforceBudget("user-1", "2026-05-10"),
    ).resolves.toBeUndefined();
  });

  it("over-budget throws HttpError(429)", async () => {
    prismaMock.coachUsage.findUnique.mockResolvedValue({
      totalTokens: MAX_TOKENS_PER_USER_PER_DAY,
    });
    const { enforceBudget } = await import("../budget");
    await expect(enforceBudget("user-1", "2026-05-10")).rejects.toMatchObject({
      statusCode: 429,
      message: "coach.budget.exceeded",
    });
    await expect(enforceBudget("user-1", "2026-05-10")).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it("recordSpend clamps non-finite tokens to 0", async () => {
    prismaMock.coachUsage.upsert.mockResolvedValue({});
    const { recordSpend } = await import("../budget");
    await recordSpend({ userId: "u", tokens: NaN });
    const args = prismaMock.coachUsage.upsert.mock.calls[0][0];
    expect(args.create.totalTokens).toBe(0);
    expect(args.update.totalTokens.increment).toBe(0);
  });

  it("recordSpend clamps negative tokens to 0", async () => {
    prismaMock.coachUsage.upsert.mockResolvedValue({});
    const { recordSpend } = await import("../budget");
    await recordSpend({ userId: "u", tokens: -42 });
    const args = prismaMock.coachUsage.upsert.mock.calls[0][0];
    expect(args.create.totalTokens).toBe(0);
  });

  it("recordSpend floors fractional tokens", async () => {
    prismaMock.coachUsage.upsert.mockResolvedValue({});
    const { recordSpend } = await import("../budget");
    await recordSpend({ userId: "u", tokens: 12.7 });
    const args = prismaMock.coachUsage.upsert.mock.calls[0][0];
    expect(args.create.totalTokens).toBe(12);
  });
});
