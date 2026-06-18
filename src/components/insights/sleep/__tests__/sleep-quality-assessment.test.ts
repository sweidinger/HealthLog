import { describe, it, expect } from "vitest";

import { buildSleepQualityAssessment } from "../sleep-quality-assessment";

/**
 * v1.18.6 — the deterministic sleep-quality grading that backs the grounded
 * "Einschätzung" when no AI narrative exists. Pins the band thresholds and the
 * worst-grade-wins overall, and the "skip ungradable metrics" contract.
 */
describe("buildSleepQualityAssessment", () => {
  it("grades efficiency on the clinical 90 / 85 / 75 floors", () => {
    expect(
      buildSleepQualityAssessment([{ type: "SLEEP_EFFICIENCY", value: 92 }])
        ?.lead.grade,
    ).toBe("excellent");
    expect(
      buildSleepQualityAssessment([{ type: "SLEEP_EFFICIENCY", value: 86 }])
        ?.lead.grade,
    ).toBe("good");
    expect(
      buildSleepQualityAssessment([{ type: "SLEEP_EFFICIENCY", value: 78 }])
        ?.lead.grade,
    ).toBe("fair");
    expect(
      buildSleepQualityAssessment([{ type: "SLEEP_EFFICIENCY", value: 60 }])
        ?.lead.grade,
    ).toBe("low");
  });

  it("grades 0–100 scores on the 90 / 85 / 70 split", () => {
    expect(
      buildSleepQualityAssessment([{ type: "SLEEP_SCORE", value: 95 }])?.lead
        .grade,
    ).toBe("excellent");
    expect(
      buildSleepQualityAssessment([{ type: "SLEEP_SCORE", value: 72 }])?.lead
        .grade,
    ).toBe("fair");
  });

  it("opens on the headline score and keeps worst-grade-wins overall", () => {
    const a = buildSleepQualityAssessment([
      { type: "SLEEP_CONSISTENCY", value: 60 },
      { type: "SLEEP_SCORE", value: 95 },
      { type: "SLEEP_EFFICIENCY", value: 92 },
    ]);
    expect(a?.lead.type).toBe("SLEEP_SCORE");
    // The low consistency pulls the overall down even though the score is high.
    expect(a?.overall).toBe("low");
    expect(a?.rest.length).toBe(2);
  });

  it("skips metrics it has no recognised band for, and returns null on none", () => {
    // SLEEP_NEED (minutes) + disturbance count are not gradable here.
    expect(
      buildSleepQualityAssessment([
        { type: "SLEEP_NEED", value: 480 },
        { type: "SLEEP_DISTURBANCE_COUNT", value: 3 },
      ]),
    ).toBeNull();
  });

  it("ignores non-finite values", () => {
    expect(
      buildSleepQualityAssessment([{ type: "SLEEP_SCORE", value: Number.NaN }]),
    ).toBeNull();
  });
});
