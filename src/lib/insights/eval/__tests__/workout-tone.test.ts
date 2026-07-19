import { describe, expect, it } from "vitest";

import { locales, type Locale } from "@/lib/i18n/config";
import { instructionLocale } from "@/lib/ai/prompts/output-language";
import {
  getWorkoutInsightSystemPrompt,
  getWorkoutInsightUserPrompt,
} from "@/lib/ai/prompts/workout-insight";

import { formatViolations, hasUnnegatedMatch } from "../tone-rules";
import { checkWorkoutToneContract } from "../workout-tone-rules";

/**
 * The workout surface's own contract, graded across all six locales.
 *
 * The shared harness (`tone-harness.test.ts`) already grades this surface for
 * the things every assessment card owes. This file grades the two it owes
 * alone: no training prescriptions, and comparison to the user's own history
 * only. Both are prompt facts, so they run with no provider and can block a
 * merge — which is the point, since a judge run that needs a key cannot.
 */

const SNAPSHOT = "{SNAPSHOT}";
const TODAY = "2026-07-18";
const OPENER_HINT =
  "Open with the overall read in plain words, then bring in the number as support — not number-first.";

function build(locale: Locale) {
  return {
    systemPrompt: getWorkoutInsightSystemPrompt(locale),
    userPrompt: getWorkoutInsightUserPrompt(
      SNAPSHOT,
      TODAY,
      locale,
      OPENER_HINT,
    ),
    instructionBody: instructionLocale(locale),
  };
}

describe("workout tone contract", () => {
  it.each(locales)("%s carries the full session contract", (locale) => {
    const violations = checkWorkoutToneContract(build(locale));
    expect(violations, formatViolations(locale, violations)).toEqual([]);
  });

  it.each(locales)("%s never invites a population comparison", (locale) => {
    const { systemPrompt } = build(locale);
    // The evidence block carries no population data, so a prompt that reached
    // for a general standard would be asking for a fabrication.
    //
    // Negation-aware, and that is load-bearing rather than incidental: the
    // shared base body BANS this exact comparison in its own words ("never
    // against a population norm"), so a plain substring scan fires on the ban
    // and reports every locale red. `hasUnnegatedMatch` is the helper the
    // shared rules already use for the same reason.
    expect(
      hasUnnegatedMatch(
        systemPrompt,
        /\b(compared to (?:other|most) (?:people|athletes|riders|runners)|for (?:your|their) age group|population (?:norm|average))\b/i,
      ),
    ).toBe(false);
  });

  it.each(locales)("%s asks for prose, never for markup", (locale) => {
    const { systemPrompt, userPrompt } = build(locale);
    expect(`${systemPrompt}\n${userPrompt}`).not.toMatch(/\bmarkdown\b/i);
  });

  it("the rules catch a prompt that drops the prescription ban", () => {
    // Positive control for the rule itself. Without it, a check that silently
    // matched nothing would report every locale green.
    const violations = checkWorkoutToneContract({
      systemPrompt: "Describe the session. Suggest a good next workout.",
      userPrompt: SNAPSHOT,
      instructionBody: "en",
    });
    expect(violations.map((v) => v.rule)).toContain(
      "workout-bans-training-prescriptions",
    );
  });

  it("the rules catch a ban that is too vague to bind", () => {
    // "No advice" without naming the specific things a model is about to
    // suggest is the shape that drifts. The rule requires the enumeration.
    const violations = checkWorkoutToneContract({
      systemPrompt:
        "NO TRAINING PRESCRIPTIONS. Do not give advice of any kind, ever.",
      userPrompt: SNAPSHOT,
      instructionBody: "en",
    });
    const rules = violations.map((v) => v.rule);
    expect(rules).toContain("workout-prescription-ban-is-specific");
    expect(rules).not.toContain("workout-bans-training-prescriptions");
  });
});
