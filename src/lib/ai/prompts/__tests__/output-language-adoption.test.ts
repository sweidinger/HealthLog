import { describe, expect, it } from "vitest";

import { locales, type Locale } from "@/lib/i18n/config";
import {
  outputLanguageDirective,
  targetLanguageName,
} from "@/lib/ai/prompts/output-language";
import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";
import {
  getGeneralStatusSystemPrompt,
  getGeneralStatusUserPrompt,
} from "@/lib/ai/prompts/general-status";
import { getBmiSystemPrompt, getBmiUserPrompt } from "@/lib/ai/prompts/bmi";
import {
  getBloodPressureSystemPrompt,
  getBloodPressureUserPrompt,
} from "@/lib/ai/prompts/blood-pressure";
import {
  getWeightSystemPrompt,
  getWeightUserPrompt,
} from "@/lib/ai/prompts/weight";
import {
  getPulseSystemPrompt,
  getPulseUserPrompt,
} from "@/lib/ai/prompts/pulse";
import { getMoodSystemPrompt, getMoodUserPrompt } from "@/lib/ai/prompts/mood";
import {
  getMedicationComplianceSystemPrompt,
  getMedicationComplianceUserPrompt,
} from "@/lib/ai/prompts/medication-compliance";
import {
  getMetricArchetypeSystemPrompt,
  getMetricArchetypeUserPrompt,
} from "@/lib/ai/prompts/metric-archetypes";
import { getStatusBatchSystemPrompt } from "@/lib/ai/prompts/status-batch";
import { buildInterpretationBlock } from "@/lib/ai/prompts/interpretation-block";
import {
  buildUserPrompt,
  buildComparisonBlock,
} from "@/lib/ai/prompts/insight-system-prompt";
import type { MetricStatusMeta } from "@/lib/insights/metric-status-registry";

/**
 * Adoption contract for the assessment prompt family.
 *
 * `output-language-contract.test.ts` pins the helper and the base system
 * prompt. This file pins the SIBLING modules that compose on top of it — the
 * per-metric system prompts, their user-prompt scaffolding, the batch wrapper,
 * the interpretation block, the insights user prompt and the Coach prefs
 * prefix.
 *
 * The invariant each module is held to: strip the one directive out of the
 * four-locale prompt and what remains is the English prompt, byte for byte.
 * That single assertion carries three guarantees. The four locales compose the
 * ENGLISH body (no German leak); the body they compose is byte-identical to
 * the English one, so an English prompt edit can never silently diverge from
 * what a French reader receives; and the directive rides EXACTLY once — the
 * double-append a module would produce by adding its own directive on top of
 * the one `getBaseSystemPrompt` already carries shows up here as a leftover,
 * and again in the occurrence count below.
 *
 * Note where the directive sits. `getBaseSystemPrompt` appends it last, and
 * each of these modules then appends its per-metric section AFTER that — so on
 * a composed prompt the directive sits at the base/section boundary rather
 * than at the very end. It is present and unambiguous either way; moving it
 * back to terminal position would mean composing the base without the
 * directive and re-appending after the section, which is a change to the
 * shared base prompt, not to these modules.
 *
 * User-prompt scaffolding carries no directive of its own (it rides the system
 * prompt), so there the invariant is plain equality with the English text.
 */

/** Words that appear in a German instruction body and in no English one. */
const GERMAN_SENTINEL =
  /AUSGABEFORMAT|Antworte ausschließlich|Einschätzung|Schreibe eine|GEBÜNDELTE|EINORDNUNGS-KONTEXT|VERGLEICHSMODUS|Analysiere/;

/** The four locales that ride the English body plus their own directive. */
const RIDERS = ["fr", "es", "it", "pl"] as const;

const ARGS = ["{SNAPSHOT}", "2026-07-18"] as const;

const META: MetricStatusMeta = {
  key: "STEP_COUNT",
  displayName: "Steps",
  unit: "steps",
  direction: "higher-better",
  archetype: "activity-fitness",
  normalRange: { low: 7000, high: 12000 },
} as unknown as MetricStatusMeta;

/**
 * System-prompt builders: every one of these composes `getBaseSystemPrompt`,
 * which already carries the directive — so none of them may append its own.
 */
const SYSTEM_BUILDERS: ReadonlyArray<{
  name: string;
  build: (locale: Locale) => string;
}> = [
  { name: "general-status", build: getGeneralStatusSystemPrompt },
  { name: "bmi", build: getBmiSystemPrompt },
  { name: "blood-pressure", build: getBloodPressureSystemPrompt },
  { name: "weight", build: getWeightSystemPrompt },
  { name: "pulse", build: getPulseSystemPrompt },
  { name: "mood", build: getMoodSystemPrompt },
  {
    name: "medication-compliance",
    build: getMedicationComplianceSystemPrompt,
  },
  {
    name: "metric-archetypes",
    build: (l) => getMetricArchetypeSystemPrompt(META, l),
  },
  {
    name: "status-batch",
    build: (l) => getStatusBatchSystemPrompt(l, ["bp", "weight"]),
  },
];

/** User-prompt scaffolding — English text for every non-German locale. */
const USER_BUILDERS: ReadonlyArray<{
  name: string;
  build: (locale: Locale) => string | undefined;
}> = [
  {
    name: "general-status",
    build: (l) => getGeneralStatusUserPrompt(...ARGS, l),
  },
  { name: "bmi", build: (l) => getBmiUserPrompt(...ARGS, l) },
  {
    name: "blood-pressure",
    build: (l) => getBloodPressureUserPrompt(...ARGS, l),
  },
  { name: "weight", build: (l) => getWeightUserPrompt(...ARGS, l) },
  { name: "pulse", build: (l) => getPulseUserPrompt(...ARGS, l) },
  { name: "mood", build: (l) => getMoodUserPrompt(...ARGS, l) },
  {
    name: "medication-compliance",
    build: (l) => getMedicationComplianceUserPrompt(...ARGS, l),
  },
  {
    name: "metric-archetypes",
    build: (l) => getMetricArchetypeUserPrompt(META, ...ARGS, l),
  },
  {
    name: "interpretation-block",
    build: (l) =>
      buildInterpretationBlock({
        metricKey: "RESTING_HEART_RATE",
        value: 58,
        sex: "MALE",
        locale: l,
      }),
  },
  {
    name: "insight-system-prompt",
    build: (l) => buildUserPrompt("{FEATURES}", "raw", l),
  },
  {
    name: "insight-comparison-block",
    build: (l) =>
      buildComparisonBlock(l, {
        baseline: "lastMonth",
        metrics: [
          {
            type: "weight",
            currentAvg: 82.1,
            baselineAvg: 83.2,
            delta: -1.1,
            deltaPercent: -1.3,
            unit: "kg",
          },
        ],
      }),
  },
  {
    name: "insight-comparison-block (no metrics)",
    build: (l) =>
      buildComparisonBlock(l, { baseline: "lastYear", metrics: [] }),
  },
];

describe.each(SYSTEM_BUILDERS)("$name system prompt", ({ build }) => {
  it.each(RIDERS)("%s composes the English body plus its directive", (l) => {
    const directive = outputLanguageDirective(l);
    expect(directive).not.toBe("");
    // Two things legitimately differ from the English prompt: the directive
    // itself, and the language name the base body interpolates into its
    // output clause ("the complete assessment in Polish"). Undo exactly those
    // two and nothing else may remain.
    const normalised = build(l)
      .replace(`\n\n${directive}`, "")
      .split(targetLanguageName(l))
      .join("English");
    expect(normalised).toBe(build("en"));
  });

  it("appends the directive exactly once — never twice", () => {
    // A module that appended its own directive on top of the one
    // `getBaseSystemPrompt` already carries would count two here.
    for (const l of RIDERS) {
      expect(occurrences(build(l), "OUTPUT LANGUAGE:"), `${l}`).toBe(1);
    }
    // de and en name their language inside their own body; no directive.
    expect(occurrences(build("de"), "OUTPUT LANGUAGE:")).toBe(0);
    expect(occurrences(build("en"), "OUTPUT LANGUAGE:")).toBe(0);
  });

  it("sends German instruction text to German readers only", () => {
    expect(GERMAN_SENTINEL.test(build("de"))).toBe(true);
    for (const l of locales) {
      if (l === "de") continue;
      expect(GERMAN_SENTINEL.test(build(l)), `${l}`).toBe(false);
    }
  });

  it("keeps German and English distinct", () => {
    expect(build("de")).not.toBe(build("en"));
  });
});

describe.each(USER_BUILDERS)("$name user prompt", ({ build }) => {
  it.each(RIDERS)("%s receives the English scaffolding verbatim", (l) => {
    expect(build(l)).toBe(build("en"));
  });

  it("sends German scaffolding to German readers only", () => {
    expect(GERMAN_SENTINEL.test(build("de") ?? "")).toBe(true);
    for (const l of locales) {
      if (l === "de") continue;
      expect(GERMAN_SENTINEL.test(build(l) ?? ""), `${l}`).toBe(false);
    }
  });
});

describe("coach preference overrides", () => {
  const prefs = { tone: "neutral", verbosity: "detailed" } as never;

  it("never carries German override lines on a non-German prompt", () => {
    for (const l of locales) {
      const prompt = getCoachSystemPrompt(l, prefs);
      if (l === "de") {
        expect(prompt).toContain("TONFALL-OVERRIDE:");
        continue;
      }
      // The French body is native; only the override prefix is at issue here.
      expect(prompt, `${l} carries a German tone override`).not.toContain(
        "TONFALL-OVERRIDE:",
      );
      expect(prompt).toContain("TONE OVERRIDE:");
      expect(prompt).not.toContain("AUSFÜHRLICHKEITS-OVERRIDE:");
      expect(prompt).toContain("VERBOSITY OVERRIDE:");
    }
  });

  it("never carries a German v1.22 addendum on a non-German prompt", () => {
    for (const l of locales) {
      const prompt = getCoachSystemPrompt(l);
      if (l === "de") {
        expect(prompt).toContain("COACH-ZUSATZ (v1.22)");
        continue;
      }
      expect(prompt, `${l}`).not.toContain("COACH-ZUSATZ (v1.22)");
      expect(prompt).toContain("COACH ADDENDUM (v1.22)");
    }
  });
});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
