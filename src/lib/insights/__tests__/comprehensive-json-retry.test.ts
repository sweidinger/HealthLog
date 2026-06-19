/**
 * v1.18.7 (MEDIUM-5) — comprehensive JSON-retry robustness.
 *
 * The comprehensive path used to fail cold to `invalid-json` on a first-pass
 * parse miss. It now reuses `buildRetryCorrectionMessage` for ONE corrective
 * retry before declaring failure. These tests pin: a first-pass miss followed
 * by a valid retry succeeds; two misses fail; and a first-pass success runs
 * no retry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const userUpdate = vi.fn();
const resolveProviderChain = vi.fn();
const resolveProvider = vi.fn();
const runRawCompletionWithFallback = vi.fn();
const extractFeatures = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => userUpdate(...a),
    },
    auditLog: { deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: (...a: unknown[]) => resolveProviderChain(...a),
  resolveProvider: (...a: unknown[]) => resolveProvider(...a),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runRawCompletionWithFallback: (...a: unknown[]) =>
    runRawCompletionWithFallback(...a),
}));
vi.mock("@/lib/insights/features", () => ({
  FeaturesPayloadTooLargeError: class extends Error {
    sizeBytes = 0;
  },
  extractFeatures: (...a: unknown[]) => extractFeatures(...a),
}));
vi.mock("@/lib/insights/glp1-plateau", () => ({
  detectGlp1Plateau: vi.fn(async () => null),
  buildGlp1PlateauPrompt: vi.fn(() => ""),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextTextForUser: vi.fn(async () => null),
  buildAboutMeInsightBlock: vi.fn(() => ""),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserInsights: vi.fn(),
}));

import { generateComprehensiveInsight } from "../comprehensive-generate";

const FEATURES = { weight: { count: 12, latest: 81.4, mean30: 82.1 } };

beforeEach(() => {
  vi.clearAllMocks();
  resolveProviderChain.mockResolvedValue([
    { providerType: "openai", instance: {} },
  ]);
  resolveProvider.mockResolvedValue({ type: "none" });
  extractFeatures.mockResolvedValue(FEATURES);
  userUpdate.mockResolvedValue({});
  // No cached text / hash → always runs a full generation (no gate hit).
  findUnique.mockResolvedValue({
    insightsPrivacyMode: "aggregated",
    insightsCachedAt: null,
    insightsCachedText: null,
    insightsExcludeMetrics: [],
    insightsSnapshotHash: null,
    insightsBriefingRerollDate: null,
  });
});

const VALID = JSON.stringify({ dailyBriefing: { paragraph: "ok" } });

describe("comprehensive JSON-retry", () => {
  it("recovers via one corrective retry after a first-pass JSON miss", async () => {
    runRawCompletionWithFallback
      .mockResolvedValueOnce({
        result: { content: "I'm sorry, here is the data:", tokensUsed: 5, model: "m" },
        workingProvider: { providerType: "openai" },
        fallbackHops: [],
      })
      .mockResolvedValueOnce({
        result: { content: VALID, tokensUsed: 10, model: "m" },
        workingProvider: { providerType: "openai" },
        fallbackHops: [],
      });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(2);
    // The retry call appends the correction to the user prompt.
    const retryParams = runRawCompletionWithFallback.mock.calls[1][0].params;
    expect(retryParams.userPrompt).toContain("did not satisfy the required");
  });

  it("fails with invalid-json when both attempts miss", async () => {
    runRawCompletionWithFallback.mockResolvedValue({
      result: { content: "still not json", tokensUsed: 5, model: "m" },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "failed", reason: "invalid-json" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(2);
  });

  it("runs no retry when the first pass is valid", async () => {
    runRawCompletionWithFallback.mockResolvedValue({
      result: { content: VALID, tokensUsed: 10, model: "m" },
      workingProvider: { providerType: "openai" },
      fallbackHops: [],
    });

    const outcome = await generateComprehensiveInsight("u1", { locale: "de" });

    expect(outcome).toEqual({ status: "generated", providerType: "openai" });
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
  });
});
