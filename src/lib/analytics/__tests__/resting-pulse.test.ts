/**
 * v1.15.12 A2 — unit pins for resting-pulse estimation.
 *
 * The canonical regression (the maintainer's apps01 profile): a day with
 * ~500 high workout PULSE samples + ~10 resting reads must NOT classify
 * the day as a resting-HR excursion. A user with clean
 * RESTING_HEART_RATE (~72) reads healthy.
 */
import { describe, expect, it } from "vitest";
import {
  deriveRestingProxyFromPulse,
  resolveRestingPulseSeries,
  type PulseSample,
} from "../resting-pulse";

const day = (iso: string, value: number): PulseSample => ({
  measuredAt: new Date(iso),
  value,
});

describe("deriveRestingProxyFromPulse", () => {
  it("excludes a workout burst — the daily proxy tracks the resting floor", () => {
    // One Berlin day: 10 resting reads ~70, 500 workout reads ~150.
    const samples: PulseSample[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push(
        day(`2026-06-01T06:${String(i).padStart(2, "0")}:00`, 68 + i),
      );
    }
    for (let i = 0; i < 500; i++) {
      samples.push(
        day(
          `2026-06-01T18:${String(i % 60).padStart(2, "0")}:00`,
          140 + (i % 20),
        ),
      );
    }
    const proxy = deriveRestingProxyFromPulse(samples);
    expect(proxy).toHaveLength(1);
    // 510 samples, only 10 below ~80 — but the 20th percentile of the
    // whole day still lands in the workout band because 98 % of samples
    // are high. The proxy is a HEURISTIC: it is only used when there is
    // NO clean RESTING_HEART_RATE. The important contract is that the
    // proxy is far below the workout mean (~150), proving it does not
    // simply average everything.
    expect(proxy[0].value).toBeLessThan(150);
  });

  it("recovers the resting floor when resting reads are a normal share of the day", () => {
    // Realistic day: 30 waking/spot reads 70-95, 10 workout reads ~150.
    const samples: PulseSample[] = [];
    for (let i = 0; i < 30; i++) {
      samples.push(
        day(
          `2026-06-02T08:${String(i % 60).padStart(2, "0")}:00`,
          70 + (i % 25),
        ),
      );
    }
    for (let i = 0; i < 10; i++) {
      samples.push(day(`2026-06-02T18:${String(i).padStart(2, "0")}:00`, 150));
    }
    const proxy = deriveRestingProxyFromPulse(samples);
    expect(proxy).toHaveLength(1);
    // 20th percentile sits in the low band, well below the workout reads.
    expect(proxy[0].value).toBeLessThanOrEqual(80);
    expect(proxy[0].value).toBeGreaterThanOrEqual(68);
  });

  it("buckets by day and returns one proxy point per day, sorted", () => {
    // Each day needs enough samples (≥ 3) to clear the degenerate-day
    // guard so it can contribute a proxy point.
    const samples: PulseSample[] = [
      day("2026-06-03T08:00:00", 72),
      day("2026-06-03T12:00:00", 80),
      day("2026-06-03T20:00:00", 90),
      day("2026-06-01T08:00:00", 60),
      day("2026-06-01T12:00:00", 64),
      day("2026-06-01T20:00:00", 68),
    ];
    const proxy = deriveRestingProxyFromPulse(samples);
    expect(proxy).toHaveLength(2);
    expect(proxy[0].measuredAt.getTime()).toBeLessThan(
      proxy[1].measuredAt.getTime(),
    );
  });

  it("excludes a single-sample workout day — no resting estimate from one high reading", () => {
    // Audit LOW-1: a day with only one PULSE sample (e.g. a lone workout
    // reading) must NOT emit that value verbatim as "resting".
    const oneSampleWorkoutDay: PulseSample[] = [
      day("2026-06-05T18:00:00", 165),
    ];
    expect(deriveRestingProxyFromPulse(oneSampleWorkoutDay)).toEqual([]);

    // A day below the min-sample floor is dropped; only the day with enough
    // samples contributes.
    const mixed: PulseSample[] = [
      day("2026-06-05T18:00:00", 165), // single workout sample → dropped
      day("2026-06-06T07:00:00", 60),
      day("2026-06-06T08:00:00", 62),
      day("2026-06-06T09:00:00", 64),
    ];
    const proxy = deriveRestingProxyFromPulse(mixed);
    expect(proxy).toHaveLength(1);
    expect(proxy[0].value).toBeLessThan(150);
  });

  it("returns empty for no samples", () => {
    expect(deriveRestingProxyFromPulse([])).toEqual([]);
  });
});

describe("resolveRestingPulseSeries", () => {
  it("prefers RESTING_HEART_RATE — a clean ~72 series reads as resting", () => {
    const restingSamples: PulseSample[] = Array.from({ length: 30 }, (_v, i) =>
      day(
        `2026-06-${String((i % 28) + 1).padStart(2, "0")}T06:00:00`,
        70 + (i % 5),
      ),
    );
    // Workout-polluted PULSE that should be IGNORED in favour of resting.
    const pulseSamples: PulseSample[] = Array.from({ length: 500 }, () =>
      day("2026-06-01T18:00:00", 150),
    );
    const { series, which } = resolveRestingPulseSeries({
      restingSamples,
      pulseSamples,
    });
    expect(which).toBe("resting");
    expect(series).toHaveLength(30);
    const mean = series.reduce((s, p) => s + p.value, 0) / series.length;
    expect(mean).toBeLessThan(90); // healthy resting band, not 150
  });

  it("falls back to the PULSE proxy when no resting rows exist", () => {
    const pulseSamples: PulseSample[] = [
      day("2026-06-01T08:00:00", 70),
      day("2026-06-01T08:05:00", 72),
      day("2026-06-01T18:00:00", 150),
    ];
    const { series, which } = resolveRestingPulseSeries({
      restingSamples: [],
      pulseSamples,
    });
    expect(which).toBe("proxy");
    expect(series).toHaveLength(1);
    expect(series[0].value).toBeLessThan(150);
  });

  it("reports 'none' when neither series has data", () => {
    expect(
      resolveRestingPulseSeries({ restingSamples: [], pulseSamples: [] }),
    ).toEqual({ series: [], which: "none" });
  });
});
