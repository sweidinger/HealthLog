/**
 * v1.7.0 W6 — unit tests for the nightly insight pre-generation cron.
 *
 * Covers:
 *   - the discovery query selects only coach-enabled, stale-cache users;
 *   - the per-user budget gate blocks a user already generated today;
 *   - the master assistant kill-switch short-circuits the whole run;
 *   - the generator outcomes tally correctly (generated / cached /
 *     skipped / failed);
 *   - the queue is registered in `allQueues` AND scheduled in
 *     reminder-worker.ts (the v1.4.37 W10 unregistered-queue catch).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const checkRateLimit = vi.fn();
const getAssistantFlags = vi.fn();

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
}));
vi.mock("@/lib/feature-flags", () => ({
  getAssistantFlags: (...a: unknown[]) => getAssistantFlags(...a),
}));
// Never reach the real generator (which would import the provider chain).
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  generateComprehensiveInsight: vi.fn(),
}));
// The seven status generators import the provider chain transitively;
// stub the modules so the warm-pass never touches a live provider when
// the test does not inject its own generators.
vi.mock("@/lib/insights/blood-pressure-status", () => ({
  generateBloodPressureStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/pulse-status", () => ({
  generatePulseStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/weight-status", () => ({
  generateWeightStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/bmi-status", () => ({
  generateBmiStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/mood-status", () => ({
  generateMoodStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/medication-compliance-status", () => ({
  generateMedicationComplianceStatusForUser: vi.fn(),
}));
vi.mock("@/lib/insights/general-status", () => ({
  generateGeneralStatusForUser: vi.fn(),
}));
// v1.8.7.1 — the generic metric generator also imports the provider
// chain transitively; stub it so the default generic warm pass never
// touches a live provider when the test does not inject its own.
vi.mock("@/lib/insights/metric-status", () => ({
  generateMetricStatus: vi.fn(async () => ({
    hasProvider: true,
    text: "ok",
    cached: false,
    updatedAt: new Date().toISOString(),
  })),
}));

import {
  runInsightPregenerate,
  forceWarmUser,
  findPregenerateCandidates,
  PREGENERATE_STALE_MS,
  INSIGHT_PREGENERATE_QUEUE,
  INSIGHT_PREGENERATE_CRON,
} from "../insight-pregenerate";

function makePrisma(users: Array<{ id: string; locale: string | null }>) {
  const findMany = vi.fn().mockResolvedValue(users);
  return {
    prisma: { user: { findMany } },
    findMany,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAssistantFlags.mockResolvedValue({
    enabled: true,
    briefing: true,
    insightStatus: true,
  });
  checkRateLimit.mockResolvedValue({ allowed: true });
});

describe("findPregenerateCandidates", () => {
  it("filters on disableCoach=false + stale-or-null cache, oldest-first, capped", async () => {
    const { prisma, findMany } = makePrisma([{ id: "u1", locale: "de" }]);
    const now = new Date("2026-05-31T04:30:00.000Z");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await findPregenerateCandidates(prisma as any, now, 50);

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where.disableCoach).toBe(false);
    expect(arg.where.OR).toEqual([
      { insightsCachedAt: null },
      {
        insightsCachedAt: {
          lt: new Date(now.getTime() - PREGENERATE_STALE_MS),
        },
      },
    ]);
    expect(arg.orderBy).toEqual({ insightsCachedAt: "asc" });
    expect(arg.take).toBe(50);
  });
});

describe("runInsightPregenerate — kill switch", () => {
  it("short-circuits when the briefing surface is disabled globally", async () => {
    getAssistantFlags.mockResolvedValue({ enabled: false, briefing: false });
    const { prisma, findMany } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn();

    const result = await runInsightPregenerate(prisma as never, {
      generate,
    });

    expect(result.total).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("runInsightPregenerate — budget gate", () => {
  it("skips the comprehensive for a budget-blocked user but never calls the generator for them", async () => {
    const { prisma } = makePrisma([
      { id: "u1", locale: "de" },
      { id: "u2", locale: "en" },
    ]);
    // u1 blocked, u2 allowed.
    checkRateLimit
      .mockResolvedValueOnce({ allowed: false })
      .mockResolvedValueOnce({ allowed: true });
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });

    const result = await runInsightPregenerate(prisma as never, {
      generate,
    });

    expect(result.total).toBe(2);
    expect(result.budgetBlocked).toBe(1);
    expect(result.generated).toBe(1);
    // The budget gate uses a dedicated bucket key, not the route bucket.
    expect(checkRateLimit).toHaveBeenCalledWith(
      "insight-pregenerate:u1",
      1,
      expect.any(Number),
    );
    // Only u2 reached the generator.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith("u2", {
      locale: "en",
      force: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("still runs the refill-only status warm for a budget-blocked user (v1.16.1)", async () => {
    // The 02:xx status crons skip every pregenerate candidate on the
    // assumption that the 04:30 pass warms their cards. A budget-blocked
    // candidate must therefore still get the warm — refill-only
    // (`force: false`), so a card already generated today is a cheap
    // cache read while a cold card generates.
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    checkRateLimit.mockResolvedValue({ allowed: false });
    const generate = vi.fn();
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(2);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.budgetBlocked).toBe(1);
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
      expect(g).toHaveBeenCalledWith("u1", { locale: "en", force: false });
    }
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de", "en"], false);
    expect(result.assessmentsWarmed).toBe(14);
    expect(result.metricAssessmentsWarmed).toBe(2);
  });
});

describe("runInsightPregenerate — force flag", () => {
  it("forces a fresh generation so the 20-24h cache window is not short-circuited to `cached`", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });

    await runInsightPregenerate(prisma as never, { generate });

    // The cron's discovery window (20 h) is shorter than the
    // generator's 24 h TTL; `force: true` bypasses the TTL re-check so
    // a 20-24h-old cache actually regenerates rather than returning
    // `cached` and wasting the budget bucket. The nightly loop also
    // threads an AbortSignal so its bounded budget can cut a stalled
    // generation off.
    expect(generate).toHaveBeenCalledWith("u1", {
      locale: "de",
      force: true,
      signal: expect.any(AbortSignal),
    });
  });
});

describe("runInsightPregenerate — outcome tally", () => {
  it("tallies generated / cached / skipped / failed", async () => {
    const { prisma } = makePrisma([
      { id: "a", locale: "de" },
      { id: "b", locale: "de" },
      { id: "c", locale: "de" },
      { id: "d", locale: null },
    ]);
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ status: "generated", providerType: "x" })
      .mockResolvedValueOnce({ status: "cached" })
      .mockResolvedValueOnce({ status: "skipped", reason: "no-provider" })
      .mockResolvedValueOnce({ status: "failed", reason: "provider-error" });

    const result = await runInsightPregenerate(prisma as never, {
      generate,
    });

    expect(result).toMatchObject({
      total: 4,
      generated: 1,
      cached: 1,
      skipped: 1,
      failed: 1,
      budgetBlocked: 0,
    });
    // Locale defaulting: v1.15.20 — non-German (incl. null) → "en",
    // matching the no-key fallback routing.
    expect(generate).toHaveBeenLastCalledWith("d", {
      locale: "en",
      force: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("tallies a comprehensive that exceeds its bounded budget as failed and aborts it (v1.16.1)", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    let observedSignal: AbortSignal | undefined;
    const generate = vi.fn().mockImplementation(
      (_userId: string, opts: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          observedSignal = opts.signal;
          setTimeout(
            () => resolve({ status: "generated", providerType: "x" }),
            120_000,
          );
        }),
    );
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    vi.useFakeTimers();
    try {
      const promise = runInsightPregenerate(prisma as never, {
        generate,
        statusGenerators,
        warmGenericMetrics,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await promise;

      // The timeout fired, aborted the still-running generation (so its
      // late resolve cannot evict the rows the warm pass writes), and the
      // refill-only warm still ran.
      expect(observedSignal?.aborted).toBe(true);
      expect(result.failed).toBe(1);
      expect(result.generated).toBe(0);
      for (const g of statusGenerators) {
        expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
      }
      expect(warmGenericMetrics).toHaveBeenCalledWith(
        "u1",
        ["de", "en"],
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runInsightPregenerate — per-metric warm pass", () => {
  function warmGen(result: { hasProvider: boolean; cached: boolean }) {
    return vi.fn().mockResolvedValue(result);
  }

  it("forces all seven status generators in BOTH locales after a successful comprehensive generation", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      warmGen({ hasProvider: true, cached: false }),
    );

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    // v1.8.3 — each generator is forced once per supported locale (de + en)
    // so the cache the client reads against (active UI locale, not the
    // persisted User.locale) is always warm.
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(2);
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: true });
      expect(g).toHaveBeenCalledWith("u1", { locale: "en", force: true });
    }
    // Seven generators × two locales = 14 fresh, provider-backed assessments.
    expect(result.assessmentsWarmed).toBe(14);
  });

  it("warms when the comprehensive pass returned `cached` (its write still evicted the per-status caches)", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi.fn().mockResolvedValue({ status: "cached" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      warmGen({ hasProvider: true, cached: false }),
    );

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(2);
    }
    expect(result.assessmentsWarmed).toBe(14);
  });

  it("does NOT warm when the comprehensive pass skipped (no provider)", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "en" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "skipped", reason: "no-provider" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      warmGen({ hasProvider: false, cached: true }),
    );

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    for (const g of statusGenerators) {
      expect(g).not.toHaveBeenCalled();
    }
    expect(result.assessmentsWarmed).toBe(0);
  });

  it("warms refill-only (force:false) when the comprehensive pass failed (v1.16.1)", async () => {
    // A failed comprehensive means no eviction ran, so today's rows (if
    // any) are still valid — the warm refills only the cold cards. Before
    // v1.16.1 this path skipped the warm entirely, leaving every card of a
    // 02:xx-skipped candidate cold until the first on-visit generation.
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "failed", reason: "provider-error" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      warmGen({ hasProvider: true, cached: false }),
    );

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(2);
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
      expect(g).toHaveBeenCalledWith("u1", { locale: "en", force: false });
    }
    expect(result.assessmentsWarmed).toBe(14);
  });

  it("warms refill-only when the comprehensive pass skipped for missing consent (v1.16.1)", async () => {
    // `skipped`/`no-consent` gates only the comprehensive briefing; the
    // per-card generators decide their own consent/provider posture, so
    // the warm still runs (the forced single-user warm already behaves
    // this way — "it is the generator, not the caller, that decides").
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "skipped", reason: "no-consent" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      warmGen({ hasProvider: true, cached: false }),
    );

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(2);
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: false });
    }
    expect(result.assessmentsWarmed).toBe(14);
  });

  it("counts only fresh provider-backed assessments and survives a thrown generator", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    const statusGenerators = [
      warmGen({ hasProvider: true, cached: false }), // counts
      warmGen({ hasProvider: false, cached: true }), // no provider — skip
      warmGen({ hasProvider: true, cached: true }), // served cache — skip
      vi.fn().mockRejectedValue(new Error("boom")), // throws — swallowed
      warmGen({ hasProvider: true, cached: false }), // counts
    ];

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
    });

    // The throw must not abort the loop — every generator was attempted
    // once per supported locale (de + en).
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(2);
    }
    // Two counting generators × two locales = 4 fresh assessments.
    expect(result.assessmentsWarmed).toBe(4);
  });
});

describe("runInsightPregenerate — generic metric warm pass (v1.8.7.1)", () => {
  it("warms the generic metric caches after a successful comprehensive generation", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "de" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    // Stub the seven specialised generators so only the generic count
    // is under test.
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(9);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(warmGenericMetrics).toHaveBeenCalledTimes(1);
    // Third arg `true` — the comprehensive write evicted the caches, so
    // the warm forces fresh generations.
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de", "en"], true);
    expect(result.metricAssessmentsWarmed).toBe(9);
  });

  it("does NOT warm the generic metric caches when the comprehensive pass skipped (no provider)", async () => {
    const { prisma } = makePrisma([{ id: "u1", locale: "en" }]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "skipped", reason: "no-provider" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: false, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(9);

    const result = await runInsightPregenerate(prisma as never, {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    expect(warmGenericMetrics).not.toHaveBeenCalled();
    expect(result.metricAssessmentsWarmed).toBe(0);
  });
});

describe("forceWarmUser — on-demand single-user warm (v1.8.7.1)", () => {
  it("warms ONLY the active locale, bypasses the budget gate, and tallies counts", async () => {
    const { prisma } = makePrisma([]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "generated", providerType: "x" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(5);

    const result = await forceWarmUser(prisma as never, "u1", "en", {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    // Comprehensive forced once, in the active locale only. The forced path
    // also threads an AbortSignal so a timeout can cut the generation off.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith("u1", {
      locale: "en",
      force: true,
      signal: expect.any(AbortSignal),
    });
    // Each specialised generator forced exactly once — the active locale,
    // NOT both de+en like the nightly cron.
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
      expect(g).toHaveBeenCalledWith("u1", { locale: "en", force: true });
    }
    // Generic warm pass runs for the single active locale.
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["en"]);
    // No 20 h budget bucket consulted on the forced path.
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      comprehensive: "generated",
      assessmentsWarmed: 7,
      metricAssessmentsWarmed: 5,
    });
  });

  it("still runs the per-status + generic warm even when the comprehensive pass skipped (no provider)", async () => {
    // v1.9.0 — the three sections are decoupled. A skipped comprehensive
    // (no provider) must NOT short-circuit the per-status + generic passes:
    // each generator resolves its own provider chain and no-ops cheaply when
    // none is configured, so running them is safe and is what warms the cards
    // when the comprehensive briefing is the only thing missing a provider.
    const { prisma } = makePrisma([]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "skipped", reason: "no-provider" });
    // Each generator independently reports no-provider — nothing warmed, but
    // it WAS invoked (it is the generator, not the caller, that decides).
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: false, cached: true }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(0);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
      expect(g).toHaveBeenCalledWith("u1", { locale: "de", force: true });
    }
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de"]);
    expect(result).toMatchObject({
      comprehensive: "skipped",
      assessmentsWarmed: 0,
      metricAssessmentsWarmed: 0,
    });
  });

  it("warms the per-status + generic caches even when the comprehensive pass fails", async () => {
    // v1.9.0 — a failed comprehensive (provider chain unhealthy this run)
    // is non-fatal: the cheaper per-status (7) + generic (~30) cards still
    // warm so the user's first click is a cache read, not a 30–60 s lazy
    // generation. This is the prod regression the stability wave closes.
    const { prisma } = makePrisma([]);
    const generate = vi
      .fn()
      .mockResolvedValue({ status: "failed", reason: "all-providers-failed" });
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(4);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
    }
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de"]);
    expect(result).toMatchObject({
      comprehensive: "failed",
      assessmentsWarmed: 7,
      metricAssessmentsWarmed: 4,
    });
  });

  it("reports a timed-out comprehensive distinctly and still warms the rest", async () => {
    // A comprehensive generation that exceeds its bounded budget is
    // abandoned and reported as `timeout`, but the per-status + generic
    // passes run regardless. The prod incident was a 102 s comprehensive
    // that aborted the whole warm with `assessments_warmed: 0`.
    const { prisma } = makePrisma([]);
    const generate = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          // Never settles within the bounded budget; the fake timers below
          // advance past it so the warm continues.
          setTimeout(
            () => resolve({ status: "generated", providerType: "x" }),
            120_000,
          );
        }),
    );
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(3);

    vi.useFakeTimers();
    try {
      const promise = forceWarmUser(prisma as never, "u1", "de", {
        generate,
        statusGenerators,
        warmGenericMetrics,
      });
      // Advance past the comprehensive budget so withTimeout fires.
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await promise;

      for (const g of statusGenerators) {
        expect(g).toHaveBeenCalledTimes(1);
      }
      expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de"]);
      expect(result).toMatchObject({
        comprehensive: "timeout",
        assessmentsWarmed: 7,
        metricAssessmentsWarmed: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("short-circuits to a no-op when the whole assistant is disabled globally", async () => {
    getAssistantFlags.mockResolvedValue({
      enabled: false,
      briefing: false,
      insightStatus: false,
    });
    const { prisma } = makePrisma([]);
    const generate = vi.fn();
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
    });

    expect(generate).not.toHaveBeenCalled();
    for (const g of statusGenerators) {
      expect(g).not.toHaveBeenCalled();
    }
    expect(result.comprehensive).toBe("skipped");
    expect(result.assessmentsWarmed).toBe(0);
  });

  it("warms the per-status + generic caches when `briefing` is off but `insightStatus` is on (L1)", async () => {
    // v1.9.0 — the route admits the job on the per-user `insightStatus`
    // surface. A global `briefing` kill-switch must not suppress the
    // assessment cards the user has enabled; only the comprehensive briefing
    // belongs to the `briefing` surface.
    getAssistantFlags.mockResolvedValue({
      enabled: true,
      briefing: false,
      insightStatus: true,
    });
    const { prisma } = makePrisma([]);
    const generate = vi.fn();
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(2);

    const result = await forceWarmUser(prisma as never, "u1", "de", {
      generate,
      statusGenerators,
      warmGenericMetrics,
    });

    // Comprehensive belongs to the `briefing` surface — skipped here.
    expect(generate).not.toHaveBeenCalled();
    // But the per-status + generic passes warm.
    for (const g of statusGenerators) {
      expect(g).toHaveBeenCalledTimes(1);
    }
    expect(warmGenericMetrics).toHaveBeenCalledWith("u1", ["de"]);
    expect(result).toMatchObject({
      comprehensive: "skipped",
      assessmentsWarmed: 7,
      metricAssessmentsWarmed: 2,
    });
  });

  it("aborts the comprehensive on timeout so its late resolve cannot evict the warmed rows (M-1)", async () => {
    // v1.9.0 race fix: `withTimeout` cannot cancel the detached generation,
    // so a comprehensive that resolves AFTER the timeout would reach its own
    // `evictPerStatusInsightCache` and delete the rows the warm passes wrote.
    // The forced path threads an AbortController; on timeout it must abort,
    // and the generation observes `signal.aborted` before its evict.
    const { prisma } = makePrisma([]);
    let observedSignal: AbortSignal | undefined;
    const generate = vi.fn().mockImplementation(
      (
        _userId: string,
        opts: { signal?: AbortSignal },
      ) =>
        new Promise((resolve) => {
          observedSignal = opts.signal;
          setTimeout(
            () => resolve({ status: "generated", providerType: "x" }),
            120_000,
          );
        }),
    );
    const statusGenerators = Array.from({ length: 7 }, () =>
      vi.fn().mockResolvedValue({ hasProvider: true, cached: false }),
    );
    const warmGenericMetrics = vi.fn().mockResolvedValue(3);

    vi.useFakeTimers();
    try {
      const promise = forceWarmUser(prisma as never, "u1", "de", {
        generate,
        statusGenerators,
        warmGenericMetrics,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await promise;

      // The timeout fired and aborted the still-running generation.
      expect(observedSignal?.aborted).toBe(true);
      expect(result.comprehensive).toBe("timeout");
      // The warm passes ran and are not undone by the abandoned comprehensive.
      for (const g of statusGenerators) {
        expect(g).toHaveBeenCalledTimes(1);
      }
      expect(result.assessmentsWarmed).toBe(7);
      expect(result.metricAssessmentsWarmed).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("queue registration", () => {
  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, "../reminder-worker.ts"),
    "utf8",
  );

  it("registers the queue name in the allQueues createQueue loop", () => {
    const match = workerSrc.match(/const allQueues\s*=\s*\[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/\bINSIGHT_PREGENERATE_QUEUE\b/);
  });

  it("schedules the cron in the schedules table (with retry policy)", () => {
    expect(workerSrc).toMatch(
      /\[\s*INSIGHT_PREGENERATE_QUEUE\s*,\s*INSIGHT_PREGENERATE_CRON\s*,\s*insightRetryOptions\s*\]/,
    );
  });

  it("registers a boss.work handler for the queue", () => {
    expect(workerSrc).toMatch(
      /boss\.work[\s\S]{0,80}INSIGHT_PREGENERATE_QUEUE/,
    );
  });

  it("exposes a sane queue name + nightly cron", () => {
    expect(INSIGHT_PREGENERATE_QUEUE).toBe("insight-pregenerate");
    // Minute Hour … — nightly single tick.
    expect(INSIGHT_PREGENERATE_CRON).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});
