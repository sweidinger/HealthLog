import { describe, it, expect } from "vitest";

import {
  PROMPT_VERSION,
  getStrictInsightsSystemPrompt,
} from "@/lib/ai/prompts/insight-generator";

/**
 * v1.4.23 W4 F6 — pins the additive Apple Health prompt ratchet.
 *
 * Asserts:
 *   1. PROMPT_VERSION sits on the 4.23.x train.
 *   2. GROUND RULE 12 ships in the EN prompt and tells the model to
 *      stay silent about HealthKit metrics when the snapshot doesn't
 *      carry them — defending against the "you don't have HRV data"
 *      apologetic-opener regression on web-only accounts.
 *   3. The German prompt carries the same rule with the same intent.
 *   4. The OUTPUT FORMAT block enumerates the new sourceMetric tokens
 *      so the model emits the additive enum values directly.
 */
describe("PROMPT_VERSION (v1.4.23 Apple Health ratchet)", () => {
  it("matches the 4.23.x train", () => {
    expect(PROMPT_VERSION).toMatch(/^4\.23\.\d+$/);
  });
});

describe("getStrictInsightsSystemPrompt — EN", () => {
  const prompt = getStrictInsightsSystemPrompt("en");

  it("carries GROUND RULE 12 with the Apple Health silent-fallback contract", () => {
    expect(prompt).toMatch(/12\. v1\.4\.23/);
    expect(prompt).toMatch(/Apple Health metric categories/);
    expect(prompt).toMatch(/HRV/);
    expect(prompt).toMatch(/sleep duration/);
    expect(prompt).toMatch(/resting HR/);
    expect(prompt).toMatch(/do not apologise/);
    expect(prompt).toMatch(/silent/);
  });

  it("does not bake live tenant figures into the new rule", () => {
    // PII rule (per the marathon brief): GROUND RULE 12 frames in terms
    // of metric categories, never a specific number / email / username.
    // The block starts at "12. v1.4.23" and ends at the
    // GUIDELINE TARGETS heading that closes the ground-rules section.
    const rule12 =
      prompt.split("12. v1.4.23")[1]?.split("GUIDELINE TARGETS")[0] ?? "";
    expect(rule12.length).toBeGreaterThan(0);
    expect(rule12).not.toMatch(/@.+\.(com|net|org|de|test)/);
    // The rule mentions metric category names but no concrete sample
    // values — categories only.
    expect(rule12).not.toMatch(/\b\d{1,3}\s*(mmHg|bpm|kcal)\b/);
  });

  it("documents the additive sourceMetric tokens in the OUTPUT FORMAT", () => {
    expect(prompt).toMatch(/hrv \| sleep \| resting_hr \| steps \| active_energy/);
  });
});

describe("getStrictInsightsSystemPrompt — DE", () => {
  const prompt = getStrictInsightsSystemPrompt("de");

  it("carries GROUND RULE 12 with the German silent-fallback wording", () => {
    expect(prompt).toMatch(/12\. v1\.4\.23/);
    expect(prompt).toMatch(/Apple-Health-Metrik-Kategorien/);
    expect(prompt).toMatch(/HRV/);
    expect(prompt).toMatch(/Schlafdauer/);
    expect(prompt).toMatch(/Ruhepuls/);
    expect(prompt).toMatch(/entschuldige dich nicht/);
    expect(prompt).toMatch(/unsichtbar/);
  });

  it("documents the additive sourceMetric tokens in the German OUTPUT FORMAT", () => {
    expect(prompt).toMatch(/hrv \| sleep \| resting_hr \| steps \| active_energy/);
  });
});
