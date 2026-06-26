import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { HttpError } from "@/lib/api-handler";
import {
  buildDateKey,
  OPERATOR_COST_CAP,
  USER_PLAN_CAP,
  resolveDailyCap,
} from "../budget";

vi.mock("@/lib/db", () => ({
  prisma: {
    coachUsage: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
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
      totalTokens: OPERATOR_COST_CAP,
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

describe("resolveDailyCap (F1 — provider-aware cap)", () => {
  it("applies the operator-cost cap to an operator-key (admin-openai) primary", () => {
    expect(resolveDailyCap([{ providerType: "admin-openai" }])).toBe(
      OPERATOR_COST_CAP,
    );
  });

  it("applies the generous user-plan cap to a ChatGPT-OAuth (codex) primary", () => {
    expect(resolveDailyCap([{ providerType: "codex" }])).toBe(USER_PLAN_CAP);
  });

  it("applies the user-plan cap to BYOK openai / anthropic / local primaries", () => {
    expect(resolveDailyCap([{ providerType: "openai" }])).toBe(USER_PLAN_CAP);
    expect(resolveDailyCap([{ providerType: "anthropic" }])).toBe(
      USER_PLAN_CAP,
    );
    expect(resolveDailyCap([{ providerType: "local" }])).toBe(USER_PLAN_CAP);
  });

  it("classifies on the PRIMARY entry — a user-egress chain with an admin-openai fallback stays user-plan", () => {
    expect(
      resolveDailyCap([
        { providerType: "codex" },
        { providerType: "admin-openai" },
      ]),
    ).toBe(USER_PLAN_CAP);
  });

  it("defaults an empty chain to the conservative operator cap", () => {
    expect(resolveDailyCap([])).toBe(OPERATOR_COST_CAP);
  });
});

describe("reserveBudget cap (F1 — user-plan path not locked out)", () => {
  let prismaMock: {
    $queryRaw: ReturnType<typeof vi.fn>;
    $executeRaw: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    const dbModule = await import("@/lib/db");
    prismaMock = dbModule.prisma as unknown as typeof prismaMock;
    prismaMock.$queryRaw.mockReset();
    prismaMock.$executeRaw.mockReset();
  });

  it("a user-plan chain does NOT trip after a spend that exceeds the operator cap", async () => {
    // Prior spend well past the 200k operator cap, but under the user-plan cap.
    const priorSpend = OPERATOR_COST_CAP + 50_000;
    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: priorSpend + 1_200 },
    ]);
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      1_200,
      "2026-05-10",
      resolveDailyCap([{ providerType: "codex" }]),
    );
    expect(res.allowed).toBe(true);
    // The reservation upsert ran; no refund executeRaw fired.
    expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
  });

  it("the operator-key path STILL trips once prior spend reaches the operator cap", async () => {
    const priorSpend = OPERATOR_COST_CAP;
    prismaMock.$queryRaw.mockResolvedValue([
      { total_tokens: priorSpend + 1_200 },
    ]);
    prismaMock.$executeRaw.mockResolvedValue(0);
    const { reserveBudget } = await import("../budget");
    const res = await reserveBudget(
      "u",
      1_200,
      "2026-05-10",
      resolveDailyCap([{ providerType: "admin-openai" }]),
    );
    expect(res.allowed).toBe(false);
    // Refund of the reservation fired on refusal.
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
  });
});

describe("reconcileSpend cached-token subtraction (F3)", () => {
  let prismaMock: { $executeRaw: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    const dbModule = await import("@/lib/db");
    prismaMock = dbModule.prisma as unknown as typeof prismaMock;
    prismaMock.$executeRaw.mockReset();
    prismaMock.$executeRaw.mockResolvedValue(0);
  });

  it("bills total_tokens minus cached input as the signed delta", async () => {
    const { reconcileSpend } = await import("../budget");
    // reserved 1200, gross 20000, cached 13000 → net actual 7000 → delta 5800.
    await reconcileSpend("u", 1_200, 20_000, "2026-05-10", 13_000);
    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    // The tagged-template interpolations carry the delta; assert it is 5800.
    const interpolations = prismaMock.$executeRaw.mock.calls[0].slice(1);
    expect(interpolations).toContain(5_800);
  });

  it("clamps a cached count larger than gross to a zero charge (delta = -reserved)", async () => {
    const { reconcileSpend } = await import("../budget");
    await reconcileSpend("u", 1_200, 5_000, "2026-05-10", 9_999);
    const interpolations = prismaMock.$executeRaw.mock.calls[0].slice(1);
    // net actual clamped to 0 → delta = 0 - 1200 = -1200.
    expect(interpolations).toContain(-1_200);
  });

  it("defaults cachedTokens to 0 (back-compat) — bills gross", async () => {
    const { reconcileSpend } = await import("../budget");
    await reconcileSpend("u", 1_000, 4_000, "2026-05-10");
    const interpolations = prismaMock.$executeRaw.mock.calls[0].slice(1);
    expect(interpolations).toContain(3_000);
  });
});

describe("OPERATOR_COST_CAP (F2 — reasoning-aware operator cap)", () => {
  it("is sized for reasoning turns, not a single non-reasoning reply", () => {
    // Was 25_000 (≈ one gpt-5.x reasoning turn). Raised so the operator-key
    // path survives a normal day of reasoning turns.
    expect(OPERATOR_COST_CAP).toBeGreaterThanOrEqual(150_000);
    // The user-plan cap is far more generous — a user's own egress is never
    // gated on the operator-cost ceiling.
    expect(USER_PLAN_CAP).toBeGreaterThan(OPERATOR_COST_CAP);
  });
});
