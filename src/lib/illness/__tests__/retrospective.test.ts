/**
 * v1.18.1 P3 — illness retrospective summary aggregation.
 *
 * Asserts the count/byMonth/byType tallies, the CHRONIC_ONGOING gap exclusion,
 * and the thin-data gate: the "typical recovery gap" is WITHHELD below the
 * min-sample floor (never a "typical" claim from one episode).
 */
import { describe, expect, it } from "vitest";
import {
  summarizeIllnessRetrospective,
  MIN_EPISODES_FOR_TYPICAL_GAP,
  type RetrospectiveEpisode,
} from "../retrospective";

function ep(over: Partial<RetrospectiveEpisode>): RetrospectiveEpisode {
  return {
    id: "e",
    type: "INFECTION",
    onsetDay: "2026-01-10",
    resolved: true,
    recoveryGapDays: 2,
    lifecycle: "ACUTE",
    ...over,
  };
}

describe("summarizeIllnessRetrospective", () => {
  it("counts episodes, resolved, by-month, by-type", () => {
    const out = summarizeIllnessRetrospective([
      ep({ id: "a", onsetDay: "2026-01-05", type: "INFECTION" }),
      ep({ id: "b", onsetDay: "2026-11-20", type: "INFECTION", resolved: false, recoveryGapDays: null }),
      ep({ id: "c", onsetDay: "2026-11-02", type: "ALLERGY" }),
    ]);
    expect(out.episodeCount).toBe(3);
    expect(out.resolvedCount).toBe(2);
    expect(out.byMonth[1]).toBe(1);
    expect(out.byMonth[11]).toBe(2);
    expect(out.byType.INFECTION).toBe(2);
    expect(out.byType.ALLERGY).toBe(1);
  });

  it("withholds the typical gap below the min-sample floor", () => {
    const out = summarizeIllnessRetrospective([
      ep({ id: "a", recoveryGapDays: 3 }),
      ep({ id: "b", recoveryGapDays: 5 }),
    ]);
    expect(MIN_EPISODES_FOR_TYPICAL_GAP).toBe(3);
    expect(out.gapSampleSize).toBe(2);
    expect(out.typicalRecoveryGapDays).toBeNull();
  });

  it("reports the median typical gap at/above the floor", () => {
    const out = summarizeIllnessRetrospective([
      ep({ id: "a", recoveryGapDays: 2 }),
      ep({ id: "b", recoveryGapDays: 4 }),
      ep({ id: "c", recoveryGapDays: 6 }),
    ]);
    expect(out.gapSampleSize).toBe(3);
    expect(out.typicalRecoveryGapDays).toBe(4);
  });

  it("excludes CHRONIC_ONGOING and null gaps from the median", () => {
    const out = summarizeIllnessRetrospective([
      ep({ id: "a", recoveryGapDays: 2 }),
      ep({ id: "b", recoveryGapDays: 4 }),
      ep({ id: "c", recoveryGapDays: 6 }),
      ep({ id: "d", recoveryGapDays: 100, lifecycle: "CHRONIC_ONGOING" }),
      ep({ id: "e", recoveryGapDays: null }),
    ]);
    expect(out.gapSampleSize).toBe(3);
    expect(out.typicalRecoveryGapDays).toBe(4);
  });
});
