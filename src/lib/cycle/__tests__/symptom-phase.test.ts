import { describe, it, expect } from "vitest";

import {
  computeSymptomPhasePatterns,
  SYMPTOM_PHASE_MIN_DAYS,
  type SymptomDay,
} from "../symptom-phase";
import type { CyclePhase } from "../types";

function phaseMap(entries: [string, CyclePhase][]): Map<string, CyclePhase> {
  return new Map(entries);
}

describe("computeSymptomPhasePatterns", () => {
  it("clusters a symptom into its dominant phase", () => {
    const days: SymptomDay[] = [
      { date: "2026-06-01", keys: ["cramps"] },
      { date: "2026-06-02", keys: ["cramps"] },
      { date: "2026-06-03", keys: ["cramps"] },
      { date: "2026-06-20", keys: ["cramps"] },
    ];
    const phases = phaseMap([
      ["2026-06-01", "MENSTRUAL"],
      ["2026-06-02", "MENSTRUAL"],
      ["2026-06-03", "MENSTRUAL"],
      ["2026-06-20", "LUTEAL"],
    ]);
    const [row] = computeSymptomPhasePatterns(days, phases);
    expect(row.symptomKey).toBe("cramps");
    expect(row.total).toBe(4);
    expect(row.counts.MENSTRUAL).toBe(3);
    expect(row.counts.LUTEAL).toBe(1);
    expect(row.topPhase).toBe("MENSTRUAL");
    expect(row.topShare).toBeCloseTo(0.75, 5);
  });

  it("drops symptoms below the min-day floor", () => {
    const days: SymptomDay[] = [
      { date: "2026-06-01", keys: ["rare"] },
      { date: "2026-06-02", keys: ["rare"] },
    ];
    const phases = phaseMap([
      ["2026-06-01", "MENSTRUAL"],
      ["2026-06-02", "FOLLICULAR"],
    ]);
    // 2 < SYMPTOM_PHASE_MIN_DAYS (3) → no row.
    expect(SYMPTOM_PHASE_MIN_DAYS).toBe(3);
    expect(computeSymptomPhasePatterns(days, phases)).toHaveLength(0);
  });

  it("ignores symptom days that fall outside any phase window", () => {
    const days: SymptomDay[] = [
      { date: "2026-06-01", keys: ["cramps"] },
      { date: "2026-06-02", keys: ["cramps"] },
      { date: "2026-06-03", keys: ["cramps"] },
      { date: "2026-06-30", keys: ["cramps"] }, // unphased → ignored
    ];
    const phases = phaseMap([
      ["2026-06-01", "LUTEAL"],
      ["2026-06-02", "LUTEAL"],
      ["2026-06-03", "LUTEAL"],
    ]);
    const [row] = computeSymptomPhasePatterns(days, phases);
    expect(row.total).toBe(3);
    expect(row.counts.LUTEAL).toBe(3);
  });
});
