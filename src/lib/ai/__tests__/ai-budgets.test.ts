import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AI_BUDGETS,
  REFERENCE_AI_SEED,
  resolveInsightsMaxTokens,
} from "../ai-budgets";

describe("AI_BUDGETS", () => {
  it("right-sizes the per-metric status output to its 30-60 word contract", () => {
    // The status card renders exactly one `{ "summary": "..." }` of 2-4
    // sentences; 1000 was over-generous. 250 caps the ceiling without
    // clipping the contract.
    expect(AI_BUDGETS.status.maxTokens).toBe(250);
    expect(AI_BUDGETS.status.temperature).toBe(0.3);
  });

  it("keeps the comprehensive temperature at 0.3 (token ceiling moved to the resolver)", () => {
    // v1.28.28 (#470) — the output-token ceiling left the static table for
    // the env-tunable resolveInsightsMaxTokens(); no static entry lingers.
    expect(AI_BUDGETS.comprehensive).not.toHaveProperty("maxTokens");
    expect(AI_BUDGETS.comprehensive.temperature).toBe(0.3);
  });

  it("keeps the narrative budget at 400 / 0.3", () => {
    expect(AI_BUDGETS.narrative.maxTokens).toBe(400);
    expect(AI_BUDGETS.narrative.temperature).toBe(0.3);
  });

  it("keeps the coach budget at 600 / 0.4", () => {
    expect(AI_BUDGETS.coach.maxTokens).toBe(600);
    expect(AI_BUDGETS.coach.temperature).toBe(0.4);
  });

  it("keeps the worker budgets (summary / facts / self-context)", () => {
    expect(AI_BUDGETS.summary).toEqual({ temperature: 0.3, maxTokens: 200 });
    expect(AI_BUDGETS.facts).toEqual({ temperature: 0.2, maxTokens: 300 });
    expect(AI_BUDGETS.selfContext.temperature).toBe(0.4);
  });

  it("exposes a stable reference seed constant", () => {
    expect(typeof REFERENCE_AI_SEED).toBe("number");
    expect(Number.isInteger(REFERENCE_AI_SEED)).toBe(true);
  });
});

// v1.28.28 (#470) — the briefing token ceiling is env-tunable: the old fixed
// 1500 truncated real briefings on verbose models (finish_reason "length"
// mid-JSON → the generic invalid-JSON 422).
describe("resolveInsightsMaxTokens", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 2500 when INSIGHTS_MAX_TOKENS is unset", () => {
    vi.stubEnv("INSIGHTS_MAX_TOKENS", "");
    expect(resolveInsightsMaxTokens()).toBe(2500);
  });

  it("honours a valid override", () => {
    vi.stubEnv("INSIGHTS_MAX_TOKENS", "4000");
    expect(resolveInsightsMaxTokens()).toBe(4000);
  });

  it("clamps below the 500 floor", () => {
    vi.stubEnv("INSIGHTS_MAX_TOKENS", "100");
    expect(resolveInsightsMaxTokens()).toBe(500);
  });

  it("clamps above the 8000 ceiling", () => {
    vi.stubEnv("INSIGHTS_MAX_TOKENS", "99999");
    expect(resolveInsightsMaxTokens()).toBe(8000);
  });

  it("falls back to the default on a non-numeric value", () => {
    vi.stubEnv("INSIGHTS_MAX_TOKENS", "plenty");
    expect(resolveInsightsMaxTokens()).toBe(2500);
  });
});
