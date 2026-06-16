/**
 * v1.18.1 P3 — illness correlation engine (the pure math).
 *
 * The reliability battery for `computeIllnessCorrelation`:
 *   - golden-fixture recovery-gap math (felt-better vs physiological return)
 *   - baseline-contamination guard (episode days must not poison the baseline)
 *   - thin-data / coverage-gate (asserts NOTHING below the floor)
 *   - pre-onset anomaly scan + nadir direction (adverse vs not)
 *   - red-flag escalation (sustained SpO2 drop / fever)
 *   - CHRONIC_ONGOING exclusion from the gap
 *
 * Pure — no DB. Series are hand-built so each finding is exactly predictable.
 */
import { describe, expect, it } from "vitest";
import type { MeasurementType } from "@/generated/prisma/client";
import {
  computeIllnessCorrelation,
  dayDiff,
  MIN_BASELINE_DAYS,
  type IllnessCorrelationInput,
  type VitalDayPoint,
} from "../correlation";

const NOW = new Date("2026-02-01T00:00:00Z");

/** Build a flat baseline series of `days` days at `value`, ending `endDay`. */
function flatBaseline(value: number, days: number, endDay: string): VitalDayPoint[] {
  const out: VitalDayPoint[] = [];
  let cursor = Date.parse(`${endDay}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    out.unshift({ day: new Date(cursor).toISOString().slice(0, 10), mean: value });
    cursor -= 24 * 60 * 60 * 1000;
  }
  return out;
}

/**
 * A baseline whose per-day means spread evenly so the MAD (and thus the band)
 * is non-zero and stable. Means cycle through `center − jitter … center +
 * jitter` so the median is `center` and the MAD is ~`jitter/2`.
 */
function jitteredBaseline(center: number, jitter: number, days: number, endDay: string): VitalDayPoint[] {
  const base = flatBaseline(center, days, endDay);
  const offsets = [-jitter, -jitter / 2, 0, jitter / 2, jitter];
  return base.map((p, i) => ({ ...p, mean: center + offsets[i % offsets.length] }));
}

function input(over: Partial<IllnessCorrelationInput>): IllnessCorrelationInput {
  return {
    episodeId: "ep1",
    window: { onsetDay: "2026-01-10", feltBetterDay: "2026-01-17", lifecycle: "ACUTE" },
    series: [],
    source: "DAY",
    now: NOW,
    ...over,
  };
}

describe("computeIllnessCorrelation — coverage gate", () => {
  it("returns insufficient with no baselined vitals", () => {
    const out = computeIllnessCorrelation(input({ series: [] }));
    expect(out.status).toBe("insufficient");
    if (out.status === "insufficient") expect(out.reason).toBe("no_baselined_vitals");
  });

  it("returns insufficient when a vital lacks the min baseline days", () => {
    const type: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type,
            baselineDays: flatBaseline(55, MIN_BASELINE_DAYS - 1, "2026-01-02"),
            episodeDays: flatBaseline(55, 6, "2026-01-15"),
          },
        ],
      }),
    );
    expect(out.status).toBe("insufficient");
  });

  it("returns insufficient when episode coverage is below the floor", () => {
    const type: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type,
            baselineDays: jitteredBaseline(55, 1, 14, "2026-01-02"),
            episodeDays: flatBaseline(55, 2, "2026-01-11"), // only 2 episode days
          },
        ],
      }),
    );
    expect(out.status).toBe("insufficient");
    if (out.status === "insufficient")
      expect(out.reason).toBe("insufficient_episode_coverage");
  });
});

describe("computeIllnessCorrelation — golden recovery-gap", () => {
  it("computes a positive gap when the body lags the felt-better marker", () => {
    // RHR baseline 55, MAD-band ≈ ±4.4 (spread ≈ 2.22, NOTABLE = 2σ). Onset
    // 01-10, felt better 01-17. RHR spikes to 75, stays clearly out-of-band
    // (≥62) through 01-19, then re-enters the band and holds from 01-20.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-09", mean: 55 }, // pre-onset, in band
      { day: "2026-01-10", mean: 70 },
      { day: "2026-01-12", mean: 75 }, // nadir
      { day: "2026-01-15", mean: 68 },
      { day: "2026-01-17", mean: 64 }, // felt-better day, still out-of-band
      { day: "2026-01-19", mean: 62 }, // still out-of-band
      { day: "2026-01-20", mean: 55 }, // return start (in band)
      { day: "2026-01-21", mean: 55 },
      { day: "2026-01-22", mean: 55 }, // stable 3 days
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays }] }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    // returned 01-20, felt better 01-17 → gap +3
    expect(out.value.recoveryGapDays).toBe(dayDiff("2026-01-17", "2026-01-20"));
    expect(out.value.recoveryGapDays).toBe(3);
    // nadir at 01-12, value 75, adverse (RHR up = adverse)
    expect(out.value.nadir[0]?.day).toBe("2026-01-12");
    expect(out.value.nadir[0]?.value).toBe(75);
    expect(out.value.nadir[0]?.adverse).toBe(true);
    expect(out.value.nadir[0]?.direction).toBe("above");
  });

  it("flags a pre-onset anomaly when the body deviated before onset", () => {
    const type: MeasurementType = "HEART_RATE_VARIABILITY";
    // HRV baseline 60±2. Drops to 30 two days before onset → adverse (down).
    const baselineDays = jitteredBaseline(60, 2, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-08", mean: 30 }, // pre-onset crash (notable)
      { day: "2026-01-10", mean: 28 },
      { day: "2026-01-12", mean: 32 },
      { day: "2026-01-14", mean: 45 },
      { day: "2026-01-15", mean: 60 },
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays }] }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.preOnset[0]?.day).toBe("2026-01-08");
    expect(out.value.preOnset[0]?.direction).toBe("below");
    expect(out.value.preOnset[0]?.adverse).toBe(true);
  });

  it("excludes CHRONIC_ONGOING from the recovery-gap", () => {
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 70 },
      { day: "2026-01-12", mean: 75 },
      { day: "2026-01-15", mean: 55 },
      { day: "2026-01-16", mean: 55 },
      { day: "2026-01-17", mean: 55 },
    ];
    const out = computeIllnessCorrelation(
      input({
        window: { onsetDay: "2026-01-10", feltBetterDay: "2026-01-15", lifecycle: "CHRONIC_ONGOING" },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.recoveryGapDays).toBeNull();
    expect(out.value.returns).toHaveLength(0);
  });

  it("leaves the gap null when the vital never stably returns (still active)", () => {
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 72 },
      { day: "2026-01-12", mean: 75 },
      { day: "2026-01-14", mean: 73 },
      { day: "2026-01-16", mean: 70 }, // never returns to band
    ];
    const out = computeIllnessCorrelation(
      input({
        window: { onsetDay: "2026-01-10", feltBetterDay: null, lifecycle: "ACUTE" },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.recoveryGapDays).toBeNull();
    expect(out.value.returns[0]?.returnedDay).toBeNull();
  });
});

describe("computeIllnessCorrelation — baseline-contamination guard", () => {
  it("uses ONLY baselineDays for the band, never the episode-span values", () => {
    // If episode-span spikes contaminated the band, the 75 readings would
    // widen the band and the deviation would shrink. We assert the band is
    // built purely from baselineDays by comparing two episodes whose
    // baselineDays are identical but episodeDays differ wildly — the nadir
    // deviationSd for the SAME nadir value must be identical.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");

    const calm = computeIllnessCorrelation(
      input({
        series: [
          {
            type,
            baselineDays,
            episodeDays: [
              { day: "2026-01-10", mean: 56 },
              { day: "2026-01-11", mean: 75 }, // single nadir
              { day: "2026-01-12", mean: 56 },
              { day: "2026-01-13", mean: 55 },
            ],
          },
        ],
      }),
    );
    const stormy = computeIllnessCorrelation(
      input({
        series: [
          {
            type,
            baselineDays,
            episodeDays: [
              { day: "2026-01-10", mean: 90 },
              { day: "2026-01-11", mean: 75 }, // SAME nadir value as calm
              { day: "2026-01-12", mean: 88 },
              { day: "2026-01-13", mean: 92 },
            ],
          },
        ],
      }),
    );
    expect(calm.status).toBe("ok");
    expect(stormy.status).toBe("ok");
    if (calm.status !== "ok" || stormy.status !== "ok") return;
    // The band center is the clean baseline median (55) in BOTH episodes —
    // the wildly different episode-span values never shift it. A contaminated
    // baseline (one that ingested the 75–92 readings) would pull the center
    // upward and the two centers would diverge.
    const calmCenter = calm.value.nadir[0]?.baselineCenter;
    const stormyCenter = stormy.value.nadir[0]?.baselineCenter;
    expect(calmCenter).toBe(55);
    expect(stormyCenter).toBe(55);
    expect(stormyCenter).toBe(calmCenter);
  });
});

describe("computeIllnessCorrelation — red-flag escalation", () => {
  it("escalates a sustained low SpO2 run", () => {
    const type: MeasurementType = "OXYGEN_SATURATION";
    const baselineDays = jitteredBaseline(98, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 91 },
      { day: "2026-01-11", mean: 90 },
      { day: "2026-01-12", mean: 89 }, // 3 consecutive ≤92
      { day: "2026-01-13", mean: 96 },
      { day: "2026-01-14", mean: 98 },
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays }] }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.redFlags).toHaveLength(1);
    expect(out.value.redFlags[0].reason).toBe("sustained_low_spo2");
    expect(out.value.redFlags[0].worstValue).toBe(89);
    expect(out.value.redFlags[0].days).toBe(3);
  });

  it("does not escalate a single low SpO2 day", () => {
    const type: MeasurementType = "OXYGEN_SATURATION";
    const baselineDays = jitteredBaseline(98, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 91 }, // one dip only
      { day: "2026-01-11", mean: 97 },
      { day: "2026-01-12", mean: 98 },
      { day: "2026-01-13", mean: 98 },
    ];
    const out = computeIllnessCorrelation(
      input({ series: [{ type, baselineDays, episodeDays }] }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.value.redFlags).toHaveLength(0);
  });

  it("escalates a MAD=0 (rock-steady) SpO2 that drops — decoupled from the band", () => {
    // A perfectly steady 98 baseline → MAD=0 → the band is DROPPED, so this
    // vital never participates in the banded loop. A 90% SpO2 run must STILL
    // escalate (the safety-critical case the band filter previously hid). To
    // satisfy the episode-coverage floor we add a separate banded RHR vital.
    const spo2: MeasurementType = "OXYGEN_SATURATION";
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: spo2,
            baselineDays: flatBaseline(98, 21, "2026-01-02"), // MAD = 0 → no band
            episodeDays: [
              { day: "2026-01-10", mean: 90 },
              { day: "2026-01-11", mean: 89 },
              { day: "2026-01-12", mean: 90 }, // 3 days ≤ 92
              { day: "2026-01-13", mean: 97 },
            ],
          },
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(55, 5, "2026-01-15"),
          },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const spo2Flag = out.value.redFlags.find(
      (f) => f.reason === "sustained_low_spo2",
    );
    expect(spo2Flag).toBeDefined();
    expect(spo2Flag?.worstValue).toBe(89);
    expect(spo2Flag?.days).toBe(3);
  });

  it("escalates a sustained fever logged via the day-log feverC (no temp series)", () => {
    // No BODY_TEMPERATURE vital at all — the canonical journaling-fever path.
    // A banded RHR vital satisfies the coverage floor; the fever escalates
    // purely from the day-log feverC union.
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(55, 5, "2026-01-15"),
          },
        ],
        dayLogFever: [
          { day: "2026-01-10", feverC: 39.2 },
          { day: "2026-01-11", feverC: 38.9 },
          { day: "2026-01-12", feverC: 38.6 }, // 3 days ≥ 38.5
          { day: "2026-01-13", feverC: 37.4 },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const fever = out.value.redFlags.find((f) => f.reason === "sustained_fever");
    expect(fever).toBeDefined();
    expect(fever?.days).toBe(3);
    expect(fever?.worstValue).toBe(39.2);
  });

  it("uses per-day MAX for fever so an evening spike is not masked by the mean", () => {
    // The mean episode series stays sub-fever; the per-day MAX crosses 38.5.
    const temp: MeasurementType = "BODY_TEMPERATURE";
    const rhr: MeasurementType = "RESTING_HEART_RATE";
    const out = computeIllnessCorrelation(
      input({
        series: [
          {
            type: temp,
            baselineDays: jitteredBaseline(36.6, 0.2, 21, "2026-01-02"),
            episodeDays: [
              { day: "2026-01-10", mean: 37.4 },
              { day: "2026-01-11", mean: 37.5 },
              { day: "2026-01-12", mean: 37.6 },
            ],
            episodeDayMax: [
              { day: "2026-01-10", mean: 38.8 },
              { day: "2026-01-11", mean: 38.7 },
              { day: "2026-01-12", mean: 38.9 }, // 3 days max ≥ 38.5
            ],
          },
          {
            type: rhr,
            baselineDays: jitteredBaseline(55, 1, 21, "2026-01-02"),
            episodeDays: flatBaseline(55, 5, "2026-01-15"),
          },
        ],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const fever = out.value.redFlags.find((f) => f.reason === "sustained_fever");
    expect(fever).toBeDefined();
    expect(fever?.days).toBe(3);
  });
});

describe("computeIllnessCorrelation — return anchor", () => {
  it("never reports a return BEFORE the first deviation (no spurious gap)", () => {
    // The vital is IN BAND for the first 4 active days (the run-up), then
    // spikes, then settles. A naive scan from i=0 would call the early in-band
    // run the 'return' and yield a negative gap. The anchored search must pick
    // the post-deviation settle (01-19), giving a positive gap.
    const type: MeasurementType = "RESTING_HEART_RATE";
    const baselineDays = jitteredBaseline(55, 1, 21, "2026-01-02");
    const episodeDays: VitalDayPoint[] = [
      { day: "2026-01-10", mean: 55 }, // in band (run-up)
      { day: "2026-01-11", mean: 55 },
      { day: "2026-01-12", mean: 55 },
      { day: "2026-01-13", mean: 75 }, // FIRST deviation
      { day: "2026-01-14", mean: 74 },
      { day: "2026-01-15", mean: 70 },
      { day: "2026-01-19", mean: 55 }, // settle start
      { day: "2026-01-20", mean: 55 },
      { day: "2026-01-21", mean: 55 }, // stable 3 days
    ];
    const out = computeIllnessCorrelation(
      input({
        window: { onsetDay: "2026-01-10", feltBetterDay: "2026-01-15", lifecycle: "ACUTE" },
        series: [{ type, baselineDays, episodeDays }],
      }),
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    // The return is the post-deviation settle, NOT the 01-10 run-up.
    expect(out.value.returns[0]?.returnedDay).toBe("2026-01-19");
    // Gap = 01-19 − 01-15 = +4 (positive — body lagged), never negative.
    expect(out.value.recoveryGapDays).toBe(4);
    expect(out.value.recoveryGapDays).toBeGreaterThan(0);
  });
});
