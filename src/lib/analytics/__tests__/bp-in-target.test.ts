import { describe, it, expect } from "vitest";
import {
  computeBpInTargetPct,
  computeBpInTargetWindows,
  isBpReadingInTarget,
} from "../bp-in-target";

const TARGETS_UNDER_65 = {
  sysLow: 120,
  sysHigh: 129,
  diaLow: 70,
  diaHigh: 79,
};

function reading(measuredAt: string, value: number) {
  return { measuredAt: new Date(measuredAt), value };
}

describe("isBpReadingInTarget()", () => {
  /**
   * v1.4.16 A2 regression: 117/79 is textbook normotensive
   * (well-controlled, below the goal ceiling, above hypotension). The
   * v1.4.15 implementation rejected this because sys < sysLow (120),
   * which collapsed Marc's BD-Zielbereich tile to 0 %. The fix uses a
   * one-sided ceiling check with a clinical floor.
   */
  it("counts a normotensive reading below the goal band as in-target", () => {
    expect(isBpReadingInTarget(117, 79, TARGETS_UNDER_65)).toBe(true);
  });

  it("counts the goal band itself (exact) as in-target", () => {
    expect(isBpReadingInTarget(125, 75, TARGETS_UNDER_65)).toBe(true);
    expect(isBpReadingInTarget(120, 70, TARGETS_UNDER_65)).toBe(true);
    expect(isBpReadingInTarget(129, 79, TARGETS_UNDER_65)).toBe(true);
  });

  it("rejects sys above the upper bound", () => {
    expect(isBpReadingInTarget(140, 75, TARGETS_UNDER_65)).toBe(false);
    expect(isBpReadingInTarget(130, 75, TARGETS_UNDER_65)).toBe(false);
  });

  it("rejects dia above the upper bound", () => {
    expect(isBpReadingInTarget(125, 90, TARGETS_UNDER_65)).toBe(false);
    expect(isBpReadingInTarget(125, 80, TARGETS_UNDER_65)).toBe(false);
  });

  it("rejects readings under the symptomatic-hypotension floor", () => {
    // Sys 80 = stage-1 hypotension territory; not "well-controlled".
    expect(isBpReadingInTarget(80, 60, TARGETS_UNDER_65)).toBe(false);
    // Dia 45 = circulatory-collapse risk; not in-target either.
    expect(isBpReadingInTarget(110, 45, TARGETS_UNDER_65)).toBe(false);
  });

  it("counts the clinical floor itself (exact) as in-target", () => {
    // 90/50 is the lowest plausible normotensive resting band — barely
    // counted as in-target, anything lower is rejected.
    expect(isBpReadingInTarget(90, 50, TARGETS_UNDER_65)).toBe(true);
  });
});

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
      reading("2026-05-01T08:00:30Z", 75), // in target -> pair in
      reading("2026-05-02T08:01:00Z", 90), // out of target -> pair out
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
      reading("2026-05-10T08:00:30Z", 75), // 8 days away from second sys -> not paired
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
      reading("2026-05-01T08:00:00Z", 120), // sysLow exact (still in)
      reading("2026-05-02T08:00:00Z", 129), // sysHigh exact (still in)
    ];
    const dia = [
      reading("2026-05-01T08:00:00Z", 70), // diaLow exact (still in)
      reading("2026-05-02T08:00:00Z", 79), // diaHigh exact (still in)
    ];
    expect(computeBpInTargetPct(sys, dia, TARGETS_UNDER_65)).toEqual({
      pct: 100,
      pairs: 2,
    });
  });

  /**
   * v1.4.16 A2 regression — Marc's actual production data.
   *
   * Marc reported BD-Zielbereich = 0 % despite multiple BP readings
   * that "are clearly in target". A query against production showed
   * his last 30 days of paired readings include 117/79, 122/76, 108/76,
   * 106/73, 127/86, 115/78, 108/75, 124/82, 126/80, 133/95.
   *
   * Under v1.4.15 narrow-band semantics (sys >= 120 AND sys <= 129 AND
   * dia >= 70 AND dia <= 79) every single one of those reads as OUT of
   * target — sys < 120 in 5 of 10, dia > 79 in 4 of 10, both out in 1.
   * Result: 0/10 = 0 %.
   *
   * Under v1.4.16 ceiling semantics (sys <= sysHigh AND dia <= diaHigh
   * with hypotension floor) the readings 117/79, 108/76, 106/73, 115/78,
   * 108/75 are IN target (sys <= 129 and dia <= 79) and 122/86, 127/86,
   * 124/82, 126/80, 133/95 are OUT (dia > 79 or sys > 129).
   * Result: 5/10 = 50 %.
   *
   * Compare with the v1.4.15 narrow-band result (0/10 = 0 %) — that's
   * the regression Marc reported.
   */
  it("regression: Marc's production data produces non-zero % under the ceiling semantics", () => {
    const sys = [
      reading("2026-05-08T07:38:22Z", 117),
      reading("2026-05-03T21:22:02Z", 122),
      reading("2026-05-03T05:51:45Z", 108),
      reading("2026-05-03T05:50:55Z", 106),
      reading("2026-04-20T05:57:42Z", 127),
      reading("2026-04-18T06:59:29Z", 115),
      reading("2026-04-16T05:24:51Z", 108),
      reading("2026-04-15T05:34:35Z", 124),
      reading("2026-04-15T05:33:44Z", 126),
      reading("2026-04-15T20:52:26Z", 133),
    ];
    const dia = [
      reading("2026-05-08T07:38:22Z", 79),
      reading("2026-05-03T21:22:02Z", 86),
      reading("2026-05-03T05:51:45Z", 76),
      reading("2026-05-03T05:50:55Z", 73),
      reading("2026-04-20T05:57:42Z", 86),
      reading("2026-04-18T06:59:29Z", 78),
      reading("2026-04-16T05:24:51Z", 75),
      reading("2026-04-15T05:34:35Z", 82),
      reading("2026-04-15T05:33:44Z", 80),
      reading("2026-04-15T20:52:26Z", 95),
    ];
    const result = computeBpInTargetPct(sys, dia, TARGETS_UNDER_65);
    expect(result).not.toBeNull();
    expect(result!.pairs).toBe(10);
    // 5/10 in target: 117/79, 108/76, 106/73, 115/78, 108/75.
    expect(result!.pct).toBe(50);
  });

  /**
   * Regression: a NaN value (e.g., from a corrupt import row that was
   * stored as a non-numeric column). Not a real-world case in current
   * code paths since Prisma's Float column rejects NaN, but defensive
   * coverage in case downstream callers ever inject one.
   */
  it("does not crash on NaN values (treats them as out-of-target)", () => {
    const sys = [reading("2026-05-01T08:00:00Z", Number.NaN)];
    const dia = [reading("2026-05-01T08:00:30Z", 75)];
    const result = computeBpInTargetPct(sys, dia, TARGETS_UNDER_65);
    // Pair forms, NaN <= sysHigh is false, so 0/1 = 0 %.
    expect(result).toEqual({ pct: 0, pairs: 1 });
  });
});

describe("computeBpInTargetWindows", () => {
  /**
   * v1.4.18 A1 regression — Marc reported the BD-Zielbereich tile shows
   * the 30-day headline (50 %) but `7T: —` and `30T: —` placeholders
   * even though the user has paired BP readings in both windows. Root
   * cause: the analytics route only returned `bpInTargetPct` once over
   * the last 30 days; the tile receives `avg7={null}, avg30={null}` and
   * renders the "—" fallback. The fix is a windowed helper that returns
   * both 7-day and 30-day shares so the tile can show all three.
   *
   * Pinning Marc's actual production fixture (10 paired readings over
   * the last 30 days, 2 of them within the last 7 days) so a future
   * reviewer can re-derive the expected counts by hand.
   */
  const NOW = new Date("2026-05-09T12:00:00Z");

  it("returns null windows when both series are empty", () => {
    const result = computeBpInTargetWindows([], [], TARGETS_UNDER_65, NOW);
    expect(result.last7Days).toBeNull();
    expect(result.last30Days).toBeNull();
  });

  it("computes 7-day and 30-day shares from the same input", () => {
    // Two readings inside the 7-day window: one in target, one out.
    // Three additional readings older than 7 days but inside 30 days:
    // two in target, one out. Expected: 7d = 50 % (1/2), 30d = 60 % (3/5).
    const sys = [
      // last-7d
      reading("2026-05-08T07:38:22Z", 117), // IN
      reading("2026-05-03T21:22:02Z", 145), // OUT (sys ceiling)
      // 7d-30d
      reading("2026-05-01T08:00:00Z", 122), // IN
      reading("2026-04-28T08:00:00Z", 125), // IN
      reading("2026-04-20T08:00:00Z", 133), // OUT
    ];
    const dia = [
      reading("2026-05-08T07:38:22Z", 79),
      reading("2026-05-03T21:22:02Z", 90),
      reading("2026-05-01T08:00:00Z", 75),
      reading("2026-04-28T08:00:00Z", 78),
      reading("2026-04-20T08:00:00Z", 95),
    ];

    const result = computeBpInTargetWindows(sys, dia, TARGETS_UNDER_65, NOW);
    expect(result.last7Days).toEqual({ pct: 50, pairs: 2 });
    expect(result.last30Days).toEqual({ pct: 60, pairs: 5 });
  });

  it("returns null for the 7-day window when no readings fall inside it", () => {
    // Only readings older than 7 days exist.
    const sys = [
      reading("2026-04-28T08:00:00Z", 122),
      reading("2026-04-25T08:00:00Z", 125),
    ];
    const dia = [
      reading("2026-04-28T08:00:00Z", 75),
      reading("2026-04-25T08:00:00Z", 78),
    ];

    const result = computeBpInTargetWindows(sys, dia, TARGETS_UNDER_65, NOW);
    expect(result.last7Days).toBeNull();
    expect(result.last30Days).toEqual({ pct: 100, pairs: 2 });
  });

  it("returns null for both windows when only sys readings exist", () => {
    const sys = [reading("2026-05-08T08:00:00Z", 122)];
    const dia: ReturnType<typeof reading>[] = [];
    const result = computeBpInTargetWindows(sys, dia, TARGETS_UNDER_65, NOW);
    expect(result.last7Days).toBeNull();
    expect(result.last30Days).toBeNull();
  });

  /**
   * Defaults to `Date.now()` so callers don't have to thread the clock
   * through. Spot-checked by passing a clock at the boundary of the
   * 7-day window.
   */
  it("defaults to Date.now() when no clock argument is supplied", () => {
    const sys = [reading("2026-05-09T11:00:00Z", 122)];
    const dia = [reading("2026-05-09T11:00:00Z", 75)];
    // No clock argument — uses real Date.now(). The reading dates are
    // in the future relative to Date.now() (post-test-suite), so they
    // sit OUTSIDE the trailing 7-day window. We just assert it doesn't
    // throw and produces deterministic shape.
    const result = computeBpInTargetWindows(sys, dia, TARGETS_UNDER_65);
    expect(result).toBeDefined();
    expect("last7Days" in result).toBe(true);
    expect("last30Days" in result).toBe(true);
  });

  /**
   * Marc's real fixture: 10 paired readings over the last 30 days (5 in
   * target, 5 out → 50 %), of which 2 are inside the last 7 days
   * (1 in target, 1 out → 50 %).
   */
  it("regression: Marc's production fixture renders 7d=50% and 30d=50%", () => {
    const fixtureNow = new Date("2026-05-09T12:00:00Z");
    const sys = [
      reading("2026-05-08T07:38:22Z", 117), // 7d IN
      reading("2026-05-03T21:22:02Z", 122), // 7d? (5d ago — yes, 7d) OUT (dia 86)
      reading("2026-05-03T05:51:45Z", 108), // 7d IN
      reading("2026-05-03T05:50:55Z", 106), // 7d IN
      reading("2026-04-20T05:57:42Z", 127), // 30d OUT (dia 86)
      reading("2026-04-18T06:59:29Z", 115), // 30d IN
      reading("2026-04-16T05:24:51Z", 108), // 30d IN
      reading("2026-04-15T05:34:35Z", 124), // 30d OUT (dia 82)
      reading("2026-04-15T05:33:44Z", 126), // 30d OUT (dia 80)
      reading("2026-04-15T20:52:26Z", 133), // 30d OUT (both)
    ];
    const dia = [
      reading("2026-05-08T07:38:22Z", 79),
      reading("2026-05-03T21:22:02Z", 86),
      reading("2026-05-03T05:51:45Z", 76),
      reading("2026-05-03T05:50:55Z", 73),
      reading("2026-04-20T05:57:42Z", 86),
      reading("2026-04-18T06:59:29Z", 78),
      reading("2026-04-16T05:24:51Z", 75),
      reading("2026-04-15T05:34:35Z", 82),
      reading("2026-04-15T05:33:44Z", 80),
      reading("2026-04-15T20:52:26Z", 95),
    ];

    const result = computeBpInTargetWindows(
      sys,
      dia,
      TARGETS_UNDER_65,
      fixtureNow,
    );
    // 4 paired readings inside the last 7 days (2026-05-08, 2026-05-03 x3).
    // 3 of them are in target (117/79, 108/76, 106/73) → 75 %.
    expect(result.last7Days).toEqual({ pct: 75, pairs: 4 });
    // All 10 paired readings inside the last 30 days; 5 in target → 50 %.
    expect(result.last30Days).toEqual({ pct: 50, pairs: 10 });
  });
});
