import { describe, it, expect } from "vitest";
import {
  getStrictInsightsSystemPrompt,
  PROMPT_VERSION,
  OUT_OF_SCOPE_REFUSAL_EN,
  OUT_OF_SCOPE_REFUSAL_DE,
} from "../prompts/insight-generator";
import { aiInsightResponseSchema, findUncitedRecommendations } from "../schema";
import { generateInsight } from "../generate-insight";
import { MockAIProvider } from "../mock-client";
import { singleUserTurn } from "../types";

/**
 * Phase C1 — scope-hardened system prompt assertions.
 *
 * These tests verify three pillars:
 *
 *   1. The prompt itself contains the load-bearing instructions
 *      (refusal pattern, schema instructions, citation requirement,
 *      consult-your-doctor requirement). Catches accidental rewrites
 *      that drop a guard.
 *   2. Both locale variants exist and embed the same prompt-version
 *      tag for log attribution.
 *   3. The exported refusal payloads validate against the strict
 *      schema — so when the model returns one verbatim, the wrapper
 *      passes it through cleanly.
 */

describe("scope-hardened system prompt", () => {
  it("English version is non-empty and contains the version tag", () => {
    const prompt = getStrictInsightsSystemPrompt("en");
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt).toContain(PROMPT_VERSION);
    expect(PROMPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("German version is non-empty and contains the version tag", () => {
    const prompt = getStrictInsightsSystemPrompt("de");
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt).toContain(PROMPT_VERSION);
  });

  it("English prompt forbids diagnosis and prescription explicitly", () => {
    const prompt = getStrictInsightsSystemPrompt("en");
    expect(prompt).toMatch(/do not diagnose/i);
    expect(prompt).toMatch(/do not prescribe/i);
  });

  it("German prompt forbids diagnosis and prescription explicitly", () => {
    const prompt = getStrictInsightsSystemPrompt("de");
    expect(prompt).toMatch(/diagnostizierst NICHT/);
    expect(prompt).toMatch(/verschreibst NICHT/);
  });

  it("English prompt instructs the doctor-consult call-to-action", () => {
    const prompt = getStrictInsightsSystemPrompt("en");
    expect(prompt).toMatch(/consult your doctor/i);
  });

  it("German prompt instructs the doctor-consult call-to-action", () => {
    const prompt = getStrictInsightsSystemPrompt("de");
    expect(prompt).toMatch(/konsultiere deinen Arzt/i);
  });

  it("English prompt requires the citation cross-check", () => {
    const prompt = getStrictInsightsSystemPrompt("en");
    expect(prompt).toContain("citations[]");
    expect(prompt).toMatch(/MUST also\s+appear in the top-level/);
  });

  it("German prompt requires the citation cross-check", () => {
    const prompt = getStrictInsightsSystemPrompt("de");
    expect(prompt).toContain("citations[]");
    expect(prompt).toMatch(/MUSS auch\s+im\s+Top-Level/);
  });

  it("English prompt names ESH/ESC 2024 BP guidance generically", () => {
    const prompt = getStrictInsightsSystemPrompt("en");
    expect(prompt).toMatch(/ESH\/ESC/);
    expect(prompt).toMatch(/140\/90/);
  });

  it("German prompt names ESH/ESC 2024 BP guidance generically", () => {
    const prompt = getStrictInsightsSystemPrompt("de");
    expect(prompt).toMatch(/ESH\/ESC/);
    expect(prompt).toMatch(/140\/90/);
  });

  it("English prompt instructs the out-of-scope refusal pattern", () => {
    const prompt = getStrictInsightsSystemPrompt("en");
    expect(prompt).toMatch(/OUT-OF-SCOPE/);
    expect(prompt).toContain(OUT_OF_SCOPE_REFUSAL_EN.summary);
  });

  it("German prompt instructs the out-of-scope refusal pattern", () => {
    const prompt = getStrictInsightsSystemPrompt("de");
    expect(prompt).toMatch(/OUT-OF-SCOPE/);
    expect(prompt).toContain(OUT_OF_SCOPE_REFUSAL_DE.summary);
  });

  it("English prompt explicitly forbids inventing measurements", () => {
    const prompt = getStrictInsightsSystemPrompt("en");
    expect(prompt).toMatch(/do not invent measurements/i);
  });

  it("German prompt explicitly forbids inventing measurements", () => {
    const prompt = getStrictInsightsSystemPrompt("de");
    expect(prompt).toMatch(/erfinde keine messwerte/i);
  });
});

describe("out-of-scope refusal payloads", () => {
  it("English refusal payload validates against the strict schema", () => {
    const result = aiInsightResponseSchema.safeParse(OUT_OF_SCOPE_REFUSAL_EN);
    expect(result.success).toBe(true);
    expect(result.data?.recommendations).toEqual([]);
    expect(result.data?.citations).toEqual([]);
  });

  it("German refusal payload validates against the strict schema", () => {
    const result = aiInsightResponseSchema.safeParse(OUT_OF_SCOPE_REFUSAL_DE);
    expect(result.success).toBe(true);
  });

  it("refusal payload has no orphan citations (trivially)", () => {
    const parsed = aiInsightResponseSchema.parse(OUT_OF_SCOPE_REFUSAL_EN);
    expect(findUncitedRecommendations(parsed)).toEqual([]);
  });

  it("wrapper accepts a model returning the refusal payload verbatim", async () => {
    const provider = new MockAIProvider({
      responses: JSON.stringify(OUT_OF_SCOPE_REFUSAL_EN),
    });
    const outcome = await generateInsight(
      provider,
      singleUserTurn({
        system: getStrictInsightsSystemPrompt("en"),
        // Deliberately out-of-scope user prompt — model is instructed to
        // return the refusal rather than fabricate health metrics.
        user: "What's the weather in Berlin tomorrow and how do I write Python?",
      }),
    );
    expect(outcome.attempts).toBe(1);
    expect(outcome.parsed.recommendations).toEqual([]);
    expect(outcome.parsed.summary).toContain("only summarise");
  });
});
