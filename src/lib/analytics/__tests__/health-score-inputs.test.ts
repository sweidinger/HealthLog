import { describe, it, expect } from "vitest";
import { buildHealthScoreBpInputs } from "../health-score-inputs";
import type { BpInTargetEnvelope } from "../bp-in-target-fast-path";

function env(partial: Partial<BpInTargetEnvelope>): BpInTargetEnvelope {
  return {
    last7Days: null,
    last30Days: null,
    last90Days: null,
    allTime: null,
    priorMonth: null,
    priorYear: null,
    path: "live",
    rowCount: 0,
    gradedScore: null,
    ...partial,
  };
}

describe("buildHealthScoreBpInputs — single Health-Score BP input builder", () => {
  /**
   * v1.17 W1b — the dashboard ring and the insights card must grade the BP
   * pillar off identical inputs. This pins the contract: given the same
   * current + prior-week envelopes, the builder produces one BP-input shape,
   * so whichever surface calls it sees the same pillar presence, value and
   * delta.
   */
  it("reads the 90-day window for the pillar rate, NOT 30-day or all-time", () => {
    const current = env({
      last30Days: { pct: 80, pairs: 10 },
      last90Days: { pct: 65, pairs: 40 },
      allTime: { pct: 50, pairs: 200 },
      gradedScore: 72,
    });
    const out = buildHealthScoreBpInputs(current, null);
    expect(out.bpInTargetPct).toBe(65);
    expect(out.bpGradedScore).toBe(72);
  });

  it("falls back to all-time only when the 90-day window is null", () => {
    const current = env({
      last90Days: null,
      allTime: { pct: 42, pairs: 100 },
      gradedScore: 60,
    });
    const out = buildHealthScoreBpInputs(current, null);
    expect(out.bpInTargetPct).toBe(42);
  });

  it("uses the prior-week 90-day window for the delta inputs", () => {
    const current = env({
      last90Days: { pct: 65, pairs: 40 },
      gradedScore: 72,
    });
    const priorWeek = env({
      last90Days: { pct: 58, pairs: 38 },
      gradedScore: 68,
    });
    const out = buildHealthScoreBpInputs(current, priorWeek);
    expect(out.bpInTargetPctPriorWeek).toBe(58);
    expect(out.bpGradedScorePriorWeek).toBe(68);
  });

  it("collapses every field to null when the current envelope is absent", () => {
    const out = buildHealthScoreBpInputs(null, null);
    expect(out).toEqual({
      bpInTargetPct: null,
      bpInTargetPctPriorWeek: null,
      bpGradedScore: null,
      bpGradedScorePriorWeek: null,
    });
  });

  it("pillar presence is identical for two callers passing the same envelopes", () => {
    // Same data → same `bpInTargetPct !== null` presence verdict on both
    // surfaces. A user with BP history outside 30 days but inside 90 days
    // keeps the pillar on BOTH the dashboard ring and the insights card.
    const current = env({
      last30Days: null, // no readings in the last month
      last90Days: { pct: 55, pairs: 12 },
      allTime: { pct: 48, pairs: 300 },
      gradedScore: 64,
    });
    const a = buildHealthScoreBpInputs(current, null);
    const b = buildHealthScoreBpInputs(current, null);
    expect(a).toEqual(b);
    expect(a.bpInTargetPct).not.toBeNull();
  });
});
