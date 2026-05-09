import { describe, it, expect } from "vitest";
import { computeBpInTargetPct } from "../bp-in-target";

const TARGETS_UNDER_65 = {
  sysLow: 120,
  sysHigh: 129,
  diaLow: 70,
  diaHigh: 79,
};

function reading(measuredAt: string, value: number) {
  return { measuredAt: new Date(measuredAt), value };
}

describe("computeBpInTargetPct", () => {
  it("returns null when either series is empty", () => {
    expect(computeBpInTargetPct([], [], TARGETS_UNDER_65)).toBeNull();
    expect(
      computeBpInTargetPct(
        [reading("2026-05-01T08:00:00Z", 125)],
        [],
        TARGETS_UNDER_65,
      ),
    ).toBeNull();
  });

  it("counts only paired readings (same-session within 5 min)", () => {
    // Two same-session pairs, one in target, one out.
    const sys = [
      reading("2026-05-01T08:00:00Z", 125), // in target
      reading("2026-05-02T08:00:00Z", 145), // out of target
    ];
    const dia = [
      reading("2026-05-01T08:00:30Z", 75), // in target → pair in
      reading("2026-05-02T08:01:00Z", 90), // out of target → pair out
    ];

    const result = computeBpInTargetPct(sys, dia, TARGETS_UNDER_65);
    expect(result).not.toBeNull();
    expect(result!.pairs).toBe(2);
    expect(result!.pct).toBe(50);
  });

  it("computes 100% when every paired reading sits inside target", () => {
    const sys = [
      reading("2026-05-01T08:00:00Z", 125),
      reading("2026-05-02T08:00:00Z", 122),
      reading("2026-05-03T08:00:00Z", 128),
    ];
    const dia = [
      reading("2026-05-01T08:00:30Z", 75),
      reading("2026-05-02T08:00:30Z", 72),
      reading("2026-05-03T08:00:30Z", 78),
    ];
    const result = computeBpInTargetPct(sys, dia, TARGETS_UNDER_65);
    expect(result).toEqual({ pct: 100, pairs: 3 });
  });

  /**
   * Regression: the v1.4.14 implementation divided by `sysData.length`,
   * which collapsed to 0 % when imports lost their second-precision
   * `measuredAt` and dia drifted past the 5-minute pairing window.
   * The fix accepts a same-Berlin-day fallback so legacy Withings
   * imports rounded to the hour still pair correctly.
   */
  it("falls back to same-Berlin-day pairing for imports rounded to the hour", () => {
    // Sys at 08:00, dia at 08:42 — outside the 5-minute window but the
    // same Berlin calendar day. Reading is in target.
    const sys = [reading("2026-05-01T06:00:00Z", 125)]; // 08:00 Berlin (CEST)
    const dia = [reading("2026-05-01T06:42:00Z", 75)]; // 08:42 Berlin (CEST)

    const result = computeBpInTargetPct(sys, dia, TARGETS_UNDER_65);
    expect(result).toEqual({ pct: 100, pairs: 1 });
  });

  /**
   * Regression: the old denominator of `sysData.length` made the tile
   * report 0 % when sys+dia readings shared a calendar day but were
   * outside the 5-minute window — even though every paired reading
   * was inside target. The fix uses the count of accepted pairs.
   */
  it("ignores sys readings without any paired dia (same-day or session)", () => {
    // Two sys readings, but only one has a same-Berlin-day dia.
    const sys = [
      reading("2026-05-01T08:00:00Z", 125), // dia exists same day
      reading("2026-05-02T08:00:00Z", 200), // out-of-band sys, no dia same day
    ];
    const dia = [
      reading("2026-05-01T08:00:30Z", 75), // pairs with first sys
      // gap on 2026-05-02 — second sys has no same-day dia
      reading("2026-05-10T08:00:30Z", 75), // 8 days away from second sys → not paired
    ];
    const result = computeBpInTargetPct(sys, dia, TARGETS_UNDER_65);
    // First sys pair is in target. Second sys's closest dia (2026-05-10)
    // is neither same-session nor same-day, so it's discarded.
    // Pre-fix: 1 / 2 sys = 50% (wrong — divides by all sys).
    // Post-fix: 1 / 1 paired = 100% (correct).
    expect(result).toEqual({ pct: 100, pairs: 1 });
  });

  it("returns null when no pairs can be formed at all", () => {
    // Sys on day 1, dia 30 days later — no pairing possible.
    const sys = [reading("2026-04-01T08:00:00Z", 125)];
    const dia = [reading("2026-05-01T08:00:00Z", 75)];
    expect(computeBpInTargetPct(sys, dia, TARGETS_UNDER_65)).toBeNull();
  });

  it("counts boundary values as in-target", () => {
    const sys = [
      reading("2026-05-01T08:00:00Z", 120), // sysLow exact
      reading("2026-05-02T08:00:00Z", 129), // sysHigh exact
    ];
    const dia = [
      reading("2026-05-01T08:00:00Z", 70), // diaLow exact
      reading("2026-05-02T08:00:00Z", 79), // diaHigh exact
    ];
    expect(computeBpInTargetPct(sys, dia, TARGETS_UNDER_65)).toEqual({
      pct: 100,
      pairs: 2,
    });
  });
});
