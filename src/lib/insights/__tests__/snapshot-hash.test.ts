/**
 * v1.16.8 — the snapshot fingerprint that gates insight regeneration.
 *
 * The hash must be: deterministic across key order (so two structurally
 * equal snapshots always match), locale-agnostic and day-label-agnostic
 * (so a midnight rollover or a locale switch alone never forces a
 * regeneration), clock-offset-agnostic (dayOffset / *DaysAgo shift with
 * `now`, not with the data), and sensitive to every actual data value
 * the prompt narrates. All assertions use fixed inputs — no clocks, no
 * timezones.
 */
import { describe, it, expect } from "vitest";

import { hashInsightSnapshot } from "../snapshot-hash";

describe("hashInsightSnapshot", () => {
  it("is a sha256 hex digest", () => {
    expect(hashInsightSnapshot({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across object key order", () => {
    const a = hashInsightSnapshot({ weight: { mean: 80, n: 3 }, pulse: 60 });
    const b = hashInsightSnapshot({ pulse: 60, weight: { n: 3, mean: 80 } });
    expect(a).toBe(b);
  });

  it("changes when a data value changes", () => {
    const a = hashInsightSnapshot({ weight: { mean: 80.0 } });
    const b = hashInsightSnapshot({ weight: { mean: 80.1 } });
    expect(a).not.toBe(b);
  });

  it("changes when an array gains an entry or reorders", () => {
    const base = hashInsightSnapshot({ series: [1, 2, 3] });
    expect(hashInsightSnapshot({ series: [1, 2, 3, 4] })).not.toBe(base);
    expect(hashInsightSnapshot({ series: [3, 2, 1] })).not.toBe(base);
  });

  it("ignores locale and day-label fields", () => {
    const de = hashInsightSnapshot({
      locale: "de",
      generatedForDay: "2026-06-10",
      weight: { mean: 80 },
    });
    const en = hashInsightSnapshot({
      locale: "en",
      generatedForDay: "2026-06-11",
      weight: { mean: 80 },
    });
    expect(de).toBe(en);
  });

  it("ignores clock-relative offsets (dayOffset, *DaysAgo) but not the values", () => {
    const yesterday = hashInsightSnapshot({
      dataCoverage: { totalMeasurements: 12, newestMeasurementDaysAgo: 0 },
      daily: [
        { dayOffset: 0, value: 80.2, n: 1 },
        { dayOffset: 1, value: 80.4, n: 2 },
      ],
    });
    const today = hashInsightSnapshot({
      dataCoverage: { totalMeasurements: 12, newestMeasurementDaysAgo: 1 },
      daily: [
        { dayOffset: 1, value: 80.2, n: 1 },
        { dayOffset: 2, value: 80.4, n: 2 },
      ],
    });
    // Same readings, one day later, nothing new logged → same fingerprint.
    expect(yesterday).toBe(today);

    const newReading = hashInsightSnapshot({
      dataCoverage: { totalMeasurements: 13, newestMeasurementDaysAgo: 0 },
      daily: [
        { dayOffset: 0, value: 79.9, n: 1 },
        { dayOffset: 1, value: 80.2, n: 1 },
        { dayOffset: 2, value: 80.4, n: 2 },
      ],
    });
    expect(newReading).not.toBe(today);
  });

  it("keeps absolute day keys in the fingerprint", () => {
    const a = hashInsightSnapshot({ recent: [{ date: "2026-06-09", mean: 80 }] });
    const b = hashInsightSnapshot({ recent: [{ date: "2026-06-10", mean: 80 }] });
    expect(a).not.toBe(b);
  });

  it("serialises Date values as ISO strings", () => {
    const a = hashInsightSnapshot({ at: new Date("2026-06-10T00:00:00.000Z") });
    const b = hashInsightSnapshot({ at: "2026-06-10T00:00:00.000Z" });
    expect(a).toBe(b);
  });

  it("treats null and missing distinctly, and drops undefined members like JSON", () => {
    const withNull = hashInsightSnapshot({ mood: null, weight: 80 });
    const withoutKey = hashInsightSnapshot({ weight: 80 });
    const withUndefined = hashInsightSnapshot({
      mood: undefined,
      weight: 80,
    } as Record<string, unknown>);
    expect(withNull).not.toBe(withoutKey);
    expect(withUndefined).toBe(withoutKey);
  });
});
