import { describe, it, expect } from "vitest";

import {
  validateNarrativeText,
  buildNarrativeCorrection,
} from "@/lib/insights/narrative/narrative-grounding";
import type { PeriodNarrativeContext } from "@/lib/insights/narrative/period-narrative";

function ctx(
  partial: Partial<PeriodNarrativeContext> = {},
): PeriodNarrativeContext {
  return {
    status: "ready",
    period: "week",
    metricDeltas: [
      {
        type: "WEIGHT" as PeriodNarrativeContext["metricDeltas"][number]["type"],
        unit: "kg",
        current: 82,
        prior: 84,
        delta: -2,
        deltaPercent: -2.4,
        currentDays: 6,
        priorDays: 7,
      },
    ],
    bandTransitions: [],
    drivers: [],
    coincidentFlags: [],
    pairsTested: 5,
    fdrQ: 0.1,
    provenance: {
      metrics: ["weight"],
      window: { from: "2026-06-01", to: "2026-06-07" },
      computedAt: "2026-06-07T00:00:00.000Z",
    },
    ...partial,
  };
}

describe("validateNarrativeText — causal language", () => {
  it("flags 'because'", () => {
    const out = validateNarrativeText(
      "Your weight fell because you slept more.",
      ctx(),
      "en",
    );
    expect(out.some((f) => f.reason === "causal_language")).toBe(true);
  });
  it("flags German 'wegen'", () => {
    const out = validateNarrativeText(
      "Dein Gewicht sank wegen des Schlafs.",
      ctx(),
      "de",
    );
    expect(out.some((f) => f.reason === "causal_language")).toBe(true);
  });
  it("flags 'culprit'", () => {
    const out = validateNarrativeText(
      "Stress is the likely culprit here.",
      ctx(),
      "en",
    );
    expect(out.some((f) => f.reason === "causal_language")).toBe(true);
  });
  it("allows descriptive 'associated with' / 'moved with'", () => {
    const out = validateNarrativeText(
      "Your weight of 82 kg moved with your sleep this week, associated with a 2 kg drop.",
      ctx(),
      "en",
    );
    expect(out).toEqual([]);
  });
});

describe("validateNarrativeText — number grounding", () => {
  it("passes numbers present in the context", () => {
    const out = validateNarrativeText(
      "Your weight is 82 kg, down 2 kg (about -2.4%) from the prior week.",
      ctx(),
      "en",
    );
    expect(out).toEqual([]);
  });
  it("flags a number not in the context", () => {
    const out = validateNarrativeText(
      "Your weight dropped 9 kg this week.",
      ctx(),
      "en",
    );
    expect(
      out.some((f) => f.reason === "ungrounded_number" && f.source === "9"),
    ).toBe(true);
  });
  it("does not flag structural integers (7-day window)", () => {
    const out = validateNarrativeText(
      "Over the last 7 days your weight held at 82 kg.",
      ctx(),
      "en",
    );
    expect(out).toEqual([]);
  });
});

describe("buildNarrativeCorrection", () => {
  it("names causal + ungrounded findings (en)", () => {
    const msg = buildNarrativeCorrection(
      [
        { reason: "causal_language", source: "because" },
        { reason: "ungrounded_number", source: "9" },
      ],
      "en",
    );
    expect(msg.toLowerCase()).toContain("causal");
    expect(msg).toContain("9");
  });
  it("produces German copy", () => {
    const msg = buildNarrativeCorrection(
      [{ reason: "causal_language", source: "weil" }],
      "de",
    );
    expect(msg).toContain("URSÄCHLICHE");
  });
});
