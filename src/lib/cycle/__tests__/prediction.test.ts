import { describe, expect, it } from "vitest";

import { addDays } from "../day-math";
import {
  clampLuteal,
  confirmSymptothermal,
  detectTempShift,
  detectTemperatureTrend,
  estimateCycleLength,
  estimatePeriodLength,
  median,
  observedPeriodLength,
  predictCycle,
  resolveLuteal,
} from "../prediction";
import type {
  CycleInput,
  CycleProfileInput,
  DayLogInput,
  NightlyTempInput,
} from "../types";

/**
 * These fixtures are the parity contract iOS reuses. Every expected date +
 * confidence is computed by hand from algorithm.md's pinned constants and
 * asserted exactly. The fixtures are constructed from a fixed seed date so the
 * assertions are timezone-independent (all day math is noon-UTC anchored).
 */

const BASE_PROFILE: CycleProfileInput = {
  goal: "TRYING_TO_CONCEIVE",
  typicalCycleLength: null,
  typicalPeriodLength: null,
  lutealPhaseLength: null,
  predictionEnabled: true,
  rawChartMode: false,
};

/** Build a chain of cycles from an anchor start, each `gap[i]` days apart. */
function cyclesFromGaps(anchor: string, gaps: number[]): CycleInput[] {
  const starts: string[] = [anchor];
  for (const g of gaps) starts.push(addDays(starts[starts.length - 1], g));
  return starts.map((startDate, i) => ({
    startDate,
    endDate: i < starts.length - 1 ? starts[i + 1] : null,
    periodEndDate: null,
    ovulationDate: null,
    ovulationConfirmed: false,
  }));
}

describe("cycle/prediction — robust statistics", () => {
  it("median: odd + even counts (even = mean of two central, unrounded)", () => {
    expect(median([28, 30, 29])).toBe(29);
    expect(median([28, 30])).toBe(29);
    expect(median([28, 31])).toBe(29.5);
    expect(median([])).toBeNaN();
  });
});

describe("cycle/prediction — cycle-length estimator (§1, §5)", () => {
  it("regular 28-day user: median 28, MAD 0 → sigma floor 1.0", () => {
    const est = estimateCycleLength([28, 28, 28, 28, 28, 28], "TRYING_TO_CONCEIVE");
    expect(est.lengthRounded).toBe(28);
    expect(est.sigma).toBe(1.0); // SIGMA_FLOOR (MAD = 0)
    expect(est.cyclesObserved).toBe(6);
    expect(est.cv).toBeCloseTo(1 / 28, 6);
  });

  it("irregular user: high MAD widens sigma", () => {
    // lengths 24,28,32,26,30,28 → median 28, deviations 4,0,4,2,2,0 → MAD 2
    const est = estimateCycleLength([24, 28, 32, 26, 30, 28], "TRYING_TO_CONCEIVE");
    expect(est.lengthRounded).toBe(28);
    expect(est.sigma).toBeCloseTo(1.4826 * 2, 6); // 2.9652
  });

  it("excludes a 3-MAD outlier from the point estimate but counts it against confidence", () => {
    // 28,28,29,28,28 + one wild 60-day (missed-log: >= 1.75*28 = 49).
    const est = estimateCycleLength([28, 28, 29, 28, 28, 60], "TRYING_TO_CONCEIVE");
    // 60 excluded → median over kept = 28, kept count = 5.
    expect(est.lengthRounded).toBe(28);
    expect(est.cyclesObserved).toBe(5);
  });

  it("hard-bounds: a 14-day length is always an outlier candidate", () => {
    const est = estimateCycleLength([28, 28, 14, 28, 29], "TRYING_TO_CONCEIVE");
    expect(est.cyclesObserved).toBe(4); // 14 excluded (< HARD_CYCLE_MIN 21)
    expect(est.lengthRounded).toBe(28);
  });

  it("perimenopause widens the fence (OUTLIER_K 4 keeps more)", () => {
    const lengths = [28, 30, 26, 40, 24, 32];
    const normal = estimateCycleLength(lengths, "TRYING_TO_CONCEIVE");
    const peri = estimateCycleLength(lengths, "PERIMENOPAUSE");
    expect(peri.cyclesObserved).toBeGreaterThanOrEqual(normal.cyclesObserved);
  });
});

describe("cycle/prediction — period-length estimator (§2)", () => {
  const cyc: CycleInput = {
    startDate: "2024-01-01",
    endDate: "2024-01-29",
    periodEndDate: null,
    ovulationDate: null,
    ovulationConfirmed: false,
  };

  function flowDay(date: string, flow: DayLogInput["flow"]): DayLogInput {
    return { date, flow, basalBodyTempC: null, ovulationTest: null, cervicalMucus: null };
  }

  it("counts a contiguous 5-day bleeding run", () => {
    const logs = [
      flowDay("2024-01-01", "MEDIUM"),
      flowDay("2024-01-02", "HEAVY"),
      flowDay("2024-01-03", "MEDIUM"),
      flowDay("2024-01-04", "LIGHT"),
      flowDay("2024-01-05", "SPOTTING"),
    ];
    expect(observedPeriodLength("2024-01-01", logs)).toBe(5);
  });

  it("tolerates a single dry day inside the run but breaks on a 2-day gap", () => {
    const logs = [
      flowDay("2024-01-01", "MEDIUM"),
      flowDay("2024-01-02", "LIGHT"),
      // 01-03 dry (single gap, tolerated)
      flowDay("2024-01-04", "LIGHT"),
      // 01-05, 01-06 dry (2-day gap → break)
      flowDay("2024-01-07", "SPOTTING"),
    ];
    expect(observedPeriodLength("2024-01-01", logs)).toBe(4); // through 01-04
  });

  it("returns 0 when startDate itself has no bleeding", () => {
    expect(observedPeriodLength("2024-01-01", [flowDay("2024-01-02", "MEDIUM")])).toBe(0);
  });

  it("estimatePeriodLength prefers explicit periodEndDate", () => {
    const c = { ...cyc, periodEndDate: "2024-01-04" }; // 4-day period
    expect(estimatePeriodLength([c], [], BASE_PROFILE)).toBe(4);
  });

  it("falls back to population default (5) with no data and no prior", () => {
    expect(estimatePeriodLength([], [], BASE_PROFILE)).toBe(5);
  });
});

describe("cycle/prediction — predictCycle calendar path (§1–§3)", () => {
  it("regular 28-day user (≥6 cycles, no logs): exact band + medium confidence", () => {
    // 7 starts → 6 completed lengths of 28. Last start 2024-06-24.
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28, 28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate;
    // 7 starts = anchor + 6*28 = 2024-01-01 + 168 days.
    expect(lastStart).toBe("2024-06-17");

    const result = predictCycle(cycles, [], BASE_PROFILE, "2024-06-24");

    expect(result.method).toBe("CALENDAR");
    expect(result.cyclesObserved).toBe(6);
    expect(result.stillLearning).toBe(false);
    expect(result.estimatedCycleLength).toBe(28);
    expect(result.estimatedCycleSd).toBe(1.0);

    // nextStart = 2024-06-17 + 28 = 2024-07-15.
    expect(result.nextPeriodStart).toBe("2024-07-15");

    // halfWidth: density 0 (no logs) → logSparsity 0.5 → penalty 1.5.
    //   Z_BAND(1) * sigma(1) * 1.5 = 1.5 → round 2 → clamp [1,14] = 2.
    expect(result.nextPeriodStartLow).toBe("2024-07-13");
    expect(result.nextPeriodStartHigh).toBe("2024-07-17");

    // Ovulation = nextStart - luteal(14) = 2024-07-01.
    expect(result.predictedOvulation).toBe("2024-07-01");
    // Fertile window ov-5 … ov+1.
    expect(result.fertileWindowStart).toBe("2024-06-26");
    expect(result.fertileWindowEnd).toBe("2024-07-02");

    // confidence = cCount(1.0) * cVariance(1.0, cv≈0.036≤0.05) * cAdherence(0.4) = 0.40.
    expect(result.confidence).toBe(0.4);
    expect(result.confidenceLabel).toBe("medium");
  });

  it("irregular user: wider band, lower confidence", () => {
    // lengths 24,32,26,30,28,28 → median 28, MAD 2 → sigma 2.9652.
    const cycles = cyclesFromGaps("2024-01-01", [24, 32, 26, 30, 28, 28]);
    const result = predictCycle(cycles, [], BASE_PROFILE, "2024-07-10");

    expect(result.estimatedCycleLength).toBe(28);
    expect(result.estimatedCycleSd).toBeCloseTo(2.97, 2);
    // halfWidth = round(1 * 2.9652 * 1.5) = round(4.4478) = 4.
    const low = result.nextPeriodStartLow;
    const high = result.nextPeriodStartHigh;
    // band half-width is 4 days each side of nextStart.
    expect(low).toBe(addDays(result.nextPeriodStart, -4));
    expect(high).toBe(addDays(result.nextPeriodStart, 4));
    // cv = 2.9652/28 ≈ 0.1059 → cVariance 0.65; cCount 1.0; cAdherence 0.4.
    // confidence = 1.0 * 0.65 * 0.4 = 0.26 → low.
    expect(result.confidence).toBe(0.26);
    expect(result.confidenceLabel).toBe("low");
  });

  it("<2 cycles cold start (1 length): priors-flavoured, stillLearning, band bonus", () => {
    // 2 starts → 1 completed length of 30.
    const cycles = cyclesFromGaps("2024-01-01", [30]);
    const result = predictCycle(cycles, [], BASE_PROFILE, "2024-02-05");

    expect(result.cyclesObserved).toBe(1);
    expect(result.stillLearning).toBe(true);
    expect(result.estimatedCycleLength).toBe(30);
    // sigma falls back to SIGMA_FLOOR 1.0 (no MAD); +COLD_START_BAND_BONUS 3.
    // halfWidth = round(1*1*1.5)=2, +3 = 5 → clamp 5.
    expect(result.nextPeriodStartLow).toBe(addDays(result.nextPeriodStart, -5));
    expect(result.nextPeriodStartHigh).toBe(addDays(result.nextPeriodStart, 5));
    // cCount(1)=0.35, cVariance(cv=1/30≈0.033≤0.05)=1.0, cAdherence=0.4.
    // confidence = 0.35 * 1.0 * 0.4 = 0.14 → low.
    expect(result.confidence).toBe(0.14);
  });

  it("0 cycles priors-only: population default 28, confidence 0.20, fixed band 4", () => {
    const onlyStart: CycleInput[] = [
      {
        startDate: "2024-05-01",
        endDate: null,
        periodEndDate: null,
        ovulationDate: null,
        ovulationConfirmed: false,
      },
    ];
    const result = predictCycle(onlyStart, [], BASE_PROFILE, "2024-05-10");

    expect(result.method).toBe("CALENDAR");
    expect(result.cyclesObserved).toBe(0);
    expect(result.stillLearning).toBe(true);
    expect(result.estimatedCycleLength).toBe(28);
    expect(result.confidence).toBe(0.2);
    // nextStart = 2024-05-01 + 28 = 2024-05-29, fixed half-width 4.
    expect(result.nextPeriodStart).toBe("2024-05-29");
    expect(result.nextPeriodStartLow).toBe("2024-05-25");
    expect(result.nextPeriodStartHigh).toBe("2024-06-02");
  });

  it("respects a user-set typical-cycle prior on cold start", () => {
    const onlyStart: CycleInput[] = [
      {
        startDate: "2024-05-01",
        endDate: null,
        periodEndDate: null,
        ovulationDate: null,
        ovulationConfirmed: false,
      },
    ];
    const profile = { ...BASE_PROFILE, typicalCycleLength: 30 };
    const result = predictCycle(onlyStart, [], profile, "2024-05-10");
    expect(result.estimatedCycleLength).toBe(30);
    expect(result.nextPeriodStart).toBe("2024-05-31");
  });

  it("logging density lifts confidence and tightens the band", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28, 28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate; // 2024-06-24
    // Log every day since the last start through 'today' = full density.
    const logs: DayLogInput[] = [];
    for (let i = 0; i <= 7; i++) {
      logs.push({
        date: addDays(lastStart, i),
        flow: i < 4 ? "MEDIUM" : "NONE",
        basalBodyTempC: null,
        ovulationTest: null,
        cervicalMucus: null,
      });
    }
    const result = predictCycle(cycles, logs, BASE_PROFILE, addDays(lastStart, 7));
    // density 1 → logSparsity 0 → penalty 1 → halfWidth round(1*1*1)=1.
    expect(result.nextPeriodStartLow).toBe(addDays(result.nextPeriodStart, -1));
    // cAdherence = 0.4 + 0.6*1 = 1.0 → confidence 1*1*1.0 = 0.98 (clamped from 1.0).
    expect(result.confidence).toBe(0.98);
    expect(result.confidenceLabel).toBe("high");
  });
});

describe("cycle/prediction — symptothermal confirmation (§4.2)", () => {
  function bbtDay(date: string, t: number, mucus: DayLogInput["cervicalMucus"] = null): DayLogInput {
    return { date, flow: null, basalBodyTempC: t, ovulationTest: null, cervicalMucus: mucus };
  }

  it("detectTempShift: 3-over-6 with the 3rd reading >= 0.2°C over the 6-day max", () => {
    // 6 low baseline ~36.40, then 3 elevated clearing the max by 0.2.
    const logs: DayLogInput[] = [];
    const start = "2024-01-01";
    const baseline = [36.4, 36.42, 36.38, 36.41, 36.4, 36.39]; // max 36.42
    baseline.forEach((t, i) => logs.push(bbtDay(addDays(start, i), t)));
    // rise: each > 36.42; 3rd (index 8) must be >= 36.62.
    logs.push(bbtDay(addDays(start, 6), 36.55));
    logs.push(bbtDay(addDays(start, 7), 36.6));
    logs.push(bbtDay(addDays(start, 8), 36.62));

    const shift = detectTempShift(logs, 0.2);
    expect(shift).not.toBeNull();
    // ovulation = day before the first elevated reading (offset 6 → 2024-01-07).
    expect(shift?.ovulationDate).toBe(addDays(start, 5));
  });

  it("detectTempShift: rejects a rise that does not clear the 0.2°C third-measurement bar", () => {
    const logs: DayLogInput[] = [];
    const start = "2024-01-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    // 3rd reading only +0.1 over the 36.42 max.
    logs.push(bbtDay(addDays(start, 6), 36.45));
    logs.push(bbtDay(addDays(start, 7), 36.48));
    logs.push(bbtDay(addDays(start, 8), 36.52));
    expect(detectTempShift(logs, 0.2)).toBeNull();
  });

  it("confirmSymptothermal requires temp-shift and mucus-peak within ±2 days", () => {
    const logs: DayLogInput[] = [];
    const start = "2024-01-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    logs.push(bbtDay(addDays(start, 6), 36.55));
    logs.push(bbtDay(addDays(start, 7), 36.6));
    logs.push(bbtDay(addDays(start, 8), 36.62));
    // temp ovulation = 2024-01-06. Add a mucus peak (EGG_WHITE) on 2024-01-06.
    logs.push({
      date: "2024-01-06",
      flow: null,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: "EGG_WHITE",
    });
    expect(confirmSymptothermal(logs)).toBe("2024-01-06");
  });

  it("predictCycle: a confirmed symptothermal ovulation overrides next-start and tightens the band", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]); // 3 lengths, last start 2024-03-25
    const lastStart = cycles[cycles.length - 1].startDate;
    expect(lastStart).toBe("2024-03-25");

    // Build a temp shift in the current (in-progress) cycle with ovulation on lastStart+13.
    const logs: DayLogInput[] = [];
    const ovDay = addDays(lastStart, 13); // ovulation we want confirmed
    // 6 baseline ending the day before the rise; rise starts ovDay+1.
    const riseStart = addDays(ovDay, 1);
    const baselineStart = addDays(riseStart, -6);
    [36.4, 36.41, 36.39, 36.4, 36.42, 36.4].forEach((t, i) =>
      logs.push(bbtDay(addDays(baselineStart, i), t)),
    );
    logs.push(bbtDay(riseStart, 36.6));
    logs.push(bbtDay(addDays(riseStart, 1), 36.62));
    logs.push(bbtDay(addDays(riseStart, 2), 36.63));
    // mucus peak agreeing with the temp ovulation.
    logs.push({
      date: ovDay,
      flow: null,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: "EGG_WHITE",
    });

    const result = predictCycle(cycles, logs, BASE_PROFILE, addDays(lastStart, 16));
    expect(result.ovulationConfirmed).toBe(true);
    expect(result.method).toBe("BLENDED");
    expect(result.predictedOvulation).toBe(ovDay);
    // nextStart = confirmed ovulation + luteal(14).
    expect(result.nextPeriodStart).toBe(addDays(ovDay, 14));
  });
});

describe("cycle/prediction — temperature-trend retrospective ovulation (§4.3)", () => {
  it("detectTemperatureTrend: 3-of-4 nights >= +0.15°C over the trailing 6-night mean", () => {
    const start = "2024-02-01";
    const nights: NightlyTempInput[] = [];
    // 6 trailing nights at 36.30 → mean 36.30.
    for (let i = 0; i < 6; i++) nights.push({ date: addDays(start, i), valueC: 36.3 });
    // 4-night window: 3 elevated (>= 36.45) + 1 not.
    nights.push({ date: addDays(start, 6), valueC: 36.46 });
    nights.push({ date: addDays(start, 7), valueC: 36.47 });
    nights.push({ date: addDays(start, 8), valueC: 36.3 });
    nights.push({ date: addDays(start, 9), valueC: 36.48 });

    const ov = detectTemperatureTrend(nights);
    // rise onset = first window night (offset 6 → 2024-02-07); ovulation = night before.
    expect(ov).toBe(addDays(start, 5));
  });

  it("predictCycle uses temperature-trend when no manual symptothermal confirmation exists", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate;
    const start = addDays(lastStart, 5);
    const nights: NightlyTempInput[] = [];
    for (let i = 0; i < 6; i++) nights.push({ date: addDays(start, i), valueC: 36.3 });
    nights.push({ date: addDays(start, 6), valueC: 36.46 });
    nights.push({ date: addDays(start, 7), valueC: 36.47 });
    nights.push({ date: addDays(start, 8), valueC: 36.48 });
    nights.push({ date: addDays(start, 9), valueC: 36.49 });

    const result = predictCycle(cycles, [], BASE_PROFILE, addDays(lastStart, 20), nights);
    expect(result.ovulationConfirmed).toBe(true);
    expect(result.method).toBe("BLENDED");
    expect(result.predictedOvulation).toBe(addDays(start, 5));
  });
});

describe("cycle/prediction — multi-cycle window scoping (QA HIGH)", () => {
  function bbtDay(date: string, t: number, mucus: DayLogInput["cervicalMucus"] = null): DayLogInput {
    return { date, flow: null, basalBodyTempC: t, ovulationTest: null, cervicalMucus: mucus };
  }

  /** Build a confirmable symptothermal shift (temp + agreeing mucus) on `ovDay`. */
  function symptothermalAround(ovDay: string): DayLogInput[] {
    const logs: DayLogInput[] = [];
    const riseStart = addDays(ovDay, 1);
    const baselineStart = addDays(riseStart, -6);
    [36.4, 36.41, 36.39, 36.4, 36.42, 36.4].forEach((t, i) =>
      logs.push(bbtDay(addDays(baselineStart, i), t)),
    );
    logs.push(bbtDay(riseStart, 36.6));
    logs.push(bbtDay(addDays(riseStart, 1), 36.62));
    logs.push(bbtDay(addDays(riseStart, 2), 36.63));
    logs.push({
      date: ovDay,
      flow: null,
      basalBodyTempC: null,
      ovulationTest: null,
      cervicalMucus: "EGG_WHITE",
    });
    return logs;
  }

  it("does not confirm a STALE prior-cycle ovulation for a multi-cycle user", () => {
    // Three confirmed cycles; last start 2024-03-25, today well into the
    // current cycle. The ONLY BBT/mucus data is a complete shift back in the
    // FIRST cycle (months ago). Pre-fix, detectTempShift returned that stale
    // shift and nextPeriodStart landed in the past.
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate;
    expect(lastStart).toBe("2024-03-25");

    const staleOv = addDays("2024-01-01", 13); // 2024-01-14, two cycles back
    const logs = symptothermalAround(staleOv);

    const today = addDays(lastStart, 16);
    const result = predictCycle(cycles, logs, BASE_PROFILE, today);

    // Stale signal is outside [lastStart − BBT_WINDOW, today] → ignored.
    expect(result.ovulationConfirmed).toBe(false);
    expect(result.method).toBe("CALENDAR");
    // Calendar next-start is in the future, never in the past.
    expect(result.nextPeriodStart >= today).toBe(true);
  });

  it("confirms the CURRENT-cycle shift even when a prior-cycle shift also exists", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate; // 2024-03-25

    const staleOv = addDays("2024-01-01", 13); // months ago
    const currentOv = addDays(lastStart, 13); // current cycle
    const logs = [...symptothermalAround(staleOv), ...symptothermalAround(currentOv)];

    const result = predictCycle(cycles, logs, BASE_PROFILE, addDays(lastStart, 16));
    expect(result.ovulationConfirmed).toBe(true);
    expect(result.predictedOvulation).toBe(currentOv);
    expect(result.nextPeriodStart).toBe(addDays(currentOv, 14));
  });

  it("detectTempShift returns the LATEST qualifying shift, not the earliest", () => {
    const logs: DayLogInput[] = [];
    // First shift around 2024-01-07.
    const start = "2024-01-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start, i), t)),
    );
    logs.push(bbtDay(addDays(start, 6), 36.6));
    logs.push(bbtDay(addDays(start, 7), 36.61));
    logs.push(bbtDay(addDays(start, 8), 36.62));
    // Drop back to baseline, then a SECOND shift a month later.
    const start2 = "2024-02-01";
    [36.4, 36.42, 36.38, 36.41, 36.4, 36.39].forEach((t, i) =>
      logs.push(bbtDay(addDays(start2, i), t)),
    );
    logs.push(bbtDay(addDays(start2, 6), 36.6));
    logs.push(bbtDay(addDays(start2, 7), 36.61));
    logs.push(bbtDay(addDays(start2, 8), 36.62));

    const shift = detectTempShift(logs, 0.2);
    // Latest match → day before the second rise onset (2024-02-07 → 2024-02-06).
    expect(shift?.ovulationDate).toBe(addDays(start2, 5));
  });
});

describe("cycle/prediction — luteal clamp single source of truth (QA HIGH)", () => {
  it("clampLuteal pins a raw value to [10, 16]", () => {
    expect(clampLuteal(8)).toBe(10);
    expect(clampLuteal(20)).toBe(16);
    expect(clampLuteal(13)).toBe(13);
  });

  it("resolveLuteal applies the default then the clamp", () => {
    expect(resolveLuteal({ lutealPhaseLength: null })).toBe(14);
    expect(resolveLuteal({ lutealPhaseLength: 8 })).toBe(10);
    expect(resolveLuteal({ lutealPhaseLength: 19 })).toBe(16);
  });

  it("predictCycle ovulation uses the CLAMPED luteal for an out-of-clamp profile", () => {
    const cycles = cyclesFromGaps("2024-01-01", [28, 28, 28]);
    const lastStart = cycles[cycles.length - 1].startDate;
    // Profile asks for luteal 8 → engine clamps to 10.
    const profile: CycleProfileInput = { ...BASE_PROFILE, lutealPhaseLength: 8 };
    const result = predictCycle(cycles, [], profile, addDays(lastStart, 5));
    // predictedOvulation = nextStart − clampedLuteal(10).
    expect(result.predictedOvulation).toBe(addDays(result.nextPeriodStart, -10));
  });
});
