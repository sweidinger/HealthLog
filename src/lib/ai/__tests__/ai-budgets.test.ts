import { describe, expect, it } from "vitest";

import { AI_BUDGETS, REFERENCE_AI_SEED } from "../ai-budgets";

describe("AI_BUDGETS", () => {
  it("right-sizes the per-metric status output to its 30-60 word contract", () => {
    // The status card renders exactly one `{ "summary": "..." }` of 2-4
    // sentences; 1000 was over-generous. 250 caps the ceiling without
    // clipping the contract.
    expect(AI_BUDGETS.status.maxTokens).toBe(250);
    expect(AI_BUDGETS.status.temperature).toBe(0.3);
  });

  it("keeps the comprehensive briefing budget at 1500 / 0.3", () => {
    expect(AI_BUDGETS.comprehensive.maxTokens).toBe(1500);
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
