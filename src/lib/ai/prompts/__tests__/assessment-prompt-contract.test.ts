import { describe, expect, it } from "vitest";
import { getBaseSystemPrompt } from "../base-system";
import {
  getMetricArchetypeSystemPrompt,
  getMetricArchetypeUserPrompt,
} from "../metric-archetypes";
import { getMetricStatusMeta } from "@/lib/insights/metric-status-registry";

/**
 * v1.12.1 — the per-metric assessment prompt gains diversity / anti-
 * repetition affordances (skip-the-step, few-shot, variety/relations
 * context). These tests pin BOTH the NEW behaviour and the UNCHANGED
 * grounding + filler-ban contracts so a future rewrite can't silently
 * regress either axis.
 */

describe("base-system assessment prompt — grounding floor preserved", () => {
  for (const locale of ["en", "de"] as const) {
    it(`${locale}: keeps own-baseline grounding (not population norms)`, () => {
      const p = getBaseSystemPrompt(locale);
      if (locale === "en") {
        expect(p).toMatch(/own baseline/i);
        expect(p).toMatch(/never against a population norm/i);
        // v1.13.x — the normal-swing verdict is now a pre-computed boolean the
        // prompt leads from; the grounding floor is that an in-swing value is
        // explicitly NOT a finding (phrased against `outsideNormalSwing`).
        expect(p).toMatch(/outsideNormalSwing: false.*not a finding/i);
      } else {
        expect(p).toMatch(/EIGENE Baseline/);
        expect(p).toMatch(/nicht gegen Bevölkerungsnormen/i);
        expect(p).toMatch(/outsideNormalSwing: false.*kein Befund/i);
      }
    });

    it(`${locale}: keeps the filler-phrase ban`, () => {
      const p = getBaseSystemPrompt(locale);
      if (locale === "en") {
        expect(p).toMatch(/FORBIDDEN PHRASES/);
        expect(p).toContain("make sure to get enough sleep");
        expect(p).toContain("consult your doctor");
      } else {
        expect(p).toMatch(/VERBOTENE FLOSKELN/);
        expect(p).toContain("achte auf ausreichend Schlaf");
      }
    });

    it(`${locale}: keeps the correlation guard (|r|>0.4, association not cause)`, () => {
      const p = getBaseSystemPrompt(locale);
      expect(p).toContain("0.4");
      if (locale === "en") {
        expect(p).toMatch(/association.*never a "cause"/i);
      } else {
        expect(p).toMatch(/Zusammenhang.*nie als "Ursache"/i);
      }
    });
  }
});

describe("base-system assessment prompt — D1: step is now skippable", () => {
  it("English: instructs to skip a manufactured step when nothing is actionable", () => {
    const p = getBaseSystemPrompt("en");
    expect(p).toMatch(/do NOT manufacture a step/i);
    expect(p).toMatch(/fabricated step is exactly the platitude/i);
  });

  it("German: instructs to skip a forced step when nothing is actionable", () => {
    const p = getBaseSystemPrompt("de");
    expect(p).toMatch(/ERZWINGE KEINEN Schritt/);
    expect(p).toMatch(/erfundener Schritt/i);
  });
});

describe("base-system assessment prompt — V2: few-shot examples present", () => {
  it("English: carries a GOOD grounded example and a BAD banned-filler counter-example", () => {
    const p = getBaseSystemPrompt("en");
    expect(p).toMatch(/EXAMPLES/);
    expect(p).toMatch(/GOOD/);
    expect(p).toMatch(/BAD/);
    // The counter-example deliberately contains a banned phrase, labelled
    // "do NOT write this" so the model learns the failure form.
    expect(p).toMatch(/do NOT write this/i);
  });

  it("German: carries grounded + counter examples", () => {
    const p = getBaseSystemPrompt("de");
    expect(p).toMatch(/BEISPIELE/);
    expect(p).toMatch(/GUT/);
    expect(p).toMatch(/SCHLECHT/);
    expect(p).toMatch(/so NICHT/i);
  });
});

describe("metric-archetype user prompt — context block plumbing", () => {
  const meta = getMetricStatusMeta("RESTING_HEART_RATE")!;

  it("appends the assessment-context block when provided", () => {
    const out = getMetricArchetypeUserPrompt(
      meta,
      "{}",
      "2026-06-05",
      "en",
      "",
      "VARIETY: lead with the trend.\n\nRELATIONS: a relation.",
    );
    expect(out).toContain("VARIETY: lead with the trend.");
    expect(out).toContain("RELATIONS: a relation.");
  });

  it("omits the block cleanly when empty (no dangling separators)", () => {
    const out = getMetricArchetypeUserPrompt(meta, "{}", "2026-06-05", "en");
    expect(out).not.toContain("VARIETY");
    expect(out).not.toContain("undefined");
  });

  it("makes the closing step conditional in the user instruction (both locales)", () => {
    expect(
      getMetricArchetypeUserPrompt(meta, "{}", "2026-06-05", "en"),
    ).toMatch(/when nothing is, skip the step/i);
    expect(
      getMetricArchetypeUserPrompt(meta, "{}", "2026-06-05", "de"),
    ).toMatch(/lass den Schritt weg/i);
  });
});

describe("metric-archetype system prompt — archetype grounding intact", () => {
  it("still injects the archetype section + metadata", () => {
    const meta = getMetricStatusMeta("SLEEP_DURATION")!;
    const sys = getMetricArchetypeSystemPrompt(meta, "en");
    expect(sys).toContain("SLEEP");
    expect(sys).toContain("Sleep duration");
  });
});
