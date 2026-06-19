import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_SECTION_IDS,
  ASSESSMENT_SECTION_PAIRS,
  getBaseSystemPrompt,
} from "../base-system";
import {
  INSIGHT_PROMPT_SECTION_IDS,
  INSIGHT_PROMPT_SECTION_PAIRS,
  getStrictInsightsSystemPrompt,
} from "../insight-generator";

/**
 * The EN/DE assessment + insight system prompts are generated from a
 * single section skeleton, with each locale supplying only its fragment.
 * These guards keep that structure honest: every section must carry BOTH
 * locale fragments, neither may be blank, and the composed prompt must be
 * exactly the fragments joined by a blank line. A future edit that adds a
 * section to one locale but not the other, or empties a fragment, trips a
 * guard here instead of silently shipping a half-translated prompt.
 */

describe("base-system assessment prompt — locale skeleton parity", () => {
  it("every section carries both EN and DE fragments, none blank", () => {
    expect(ASSESSMENT_SECTION_PAIRS.length).toBeGreaterThan(0);
    for (const s of ASSESSMENT_SECTION_PAIRS) {
      expect(s.en.trim().length, `EN fragment for "${s.id}"`).toBeGreaterThan(
        0,
      );
      expect(s.de.trim().length, `DE fragment for "${s.id}"`).toBeGreaterThan(
        0,
      );
    }
  });

  it("section ids are unique", () => {
    expect(new Set(ASSESSMENT_SECTION_IDS).size).toBe(
      ASSESSMENT_SECTION_IDS.length,
    );
  });

  it("the composed prompt equals the fragments joined by a blank line", () => {
    for (const locale of ["en", "de"] as const) {
      const expected = ASSESSMENT_SECTION_PAIRS.map((s) => s[locale]).join(
        "\n\n",
      );
      expect(getBaseSystemPrompt(locale)).toBe(expected);
    }
  });
});

describe("insight system prompt — locale skeleton parity", () => {
  it("every section carries both EN and DE fragments, none blank", () => {
    expect(INSIGHT_PROMPT_SECTION_PAIRS.length).toBeGreaterThan(0);
    for (const s of INSIGHT_PROMPT_SECTION_PAIRS) {
      expect(s.en.trim().length, `EN fragment for "${s.id}"`).toBeGreaterThan(
        0,
      );
      expect(s.de.trim().length, `DE fragment for "${s.id}"`).toBeGreaterThan(
        0,
      );
    }
  });

  it("section ids are unique", () => {
    expect(new Set(INSIGHT_PROMPT_SECTION_IDS).size).toBe(
      INSIGHT_PROMPT_SECTION_IDS.length,
    );
  });

  it("the composed prompt equals the fragments joined by a blank line", () => {
    for (const locale of ["en", "de"] as const) {
      const expected = INSIGHT_PROMPT_SECTION_PAIRS.map((s) => s[locale]).join(
        "\n\n",
      );
      expect(getStrictInsightsSystemPrompt(locale)).toBe(expected);
    }
  });
});
