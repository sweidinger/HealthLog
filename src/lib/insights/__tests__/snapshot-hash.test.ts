/**
 * v1.16.8 — the snapshot fingerprint that gates insight regeneration.
 *
 * The hash must be: deterministic across key order (so two structurally
 * equal snapshots always match), locale-agnostic and day-label-agnostic
 * (so a midnight rollover or a locale switch alone never forces a
 * regeneration), clock-offset-agnostic for positional offsets (dayOffset
 * shifts with `now`, not with the data), tier-bucketed for the `*DaysAgo`
 * recency keys (stable within a staleness tier, flipping exactly at the
 * 1/2, 7/8 and 30/31 boundaries so the staleness caveat can re-enter the
 * text), and sensitive to every actual data value the prompt narrates.
 * All assertions use fixed inputs — no clocks, no timezones.
 */
import { describe, it, expect } from "vitest";

import { hashInsightSnapshot, stalenessTier } from "../snapshot-hash";

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

  it("does NOT ignore generationLocale or comparisonBaseline (the comprehensive composite)", () => {
    // The comprehensive fingerprint carries the generation language and
    // the comparison toggle under non-volatile names so a reader-facing
    // change regenerates the briefing exactly once. `locale` itself
    // stays volatile (per-locale-keyed status caches rely on that).
    const base = hashInsightSnapshot({
      features: { weight: { mean: 80 } },
      aboutMe: null,
      comparisonBaseline: "none",
      generationLocale: "de",
    });
    expect(
      hashInsightSnapshot({
        features: { weight: { mean: 80 } },
        aboutMe: null,
        comparisonBaseline: "none",
        generationLocale: "en",
      }),
    ).not.toBe(base);
    expect(
      hashInsightSnapshot({
        features: { weight: { mean: 80 } },
        aboutMe: null,
        comparisonBaseline: "lastMonth",
        generationLocale: "de",
      }),
    ).not.toBe(base);
  });

  it("ignores positional offsets (dayOffset) but not the values", () => {
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
    // Same readings, one day later, nothing new logged, recency still in
    // the fresh tier (0 → 1 days) → same fingerprint.
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

  describe("staleness tiers for *DaysAgo keys", () => {
    /** Snapshot with identical data values and a varying recency. */
    function snap(newestMeasurementDaysAgo: number | null) {
      return {
        dataCoverage: { totalMeasurements: 12, newestMeasurementDaysAgo },
        weight: { mean: 80.2, n: 12 },
      };
    }

    it("maps day counts onto the 0-1 / 2-7 / 8-30 / 30+ tiers", () => {
      expect(stalenessTier(0)).toBe("0-1d");
      expect(stalenessTier(1)).toBe("0-1d");
      expect(stalenessTier(2)).toBe("2-7d");
      expect(stalenessTier(7)).toBe("2-7d");
      expect(stalenessTier(8)).toBe("8-30d");
      expect(stalenessTier(30)).toBe("8-30d");
      expect(stalenessTier(31)).toBe("30d+");
      expect(stalenessTier(365)).toBe("30d+");
    });

    it("is stable while the recency stays within one tier", () => {
      expect(hashInsightSnapshot(snap(0))).toBe(hashInsightSnapshot(snap(1)));
      expect(hashInsightSnapshot(snap(2))).toBe(hashInsightSnapshot(snap(7)));
      expect(hashInsightSnapshot(snap(8))).toBe(hashInsightSnapshot(snap(30)));
      expect(hashInsightSnapshot(snap(31))).toBe(
        hashInsightSnapshot(snap(120)),
      );
    });

    it("flips exactly when the recency crosses a tier boundary", () => {
      // The day a user's data goes from "fresh" to "going stale" to
      // "stale" the fingerprint must change, so the cached text picks up
      // (or escalates) the out-of-date caveat instead of being re-stamped
      // as current forever.
      expect(hashInsightSnapshot(snap(1))).not.toBe(
        hashInsightSnapshot(snap(2)),
      );
      expect(hashInsightSnapshot(snap(7))).not.toBe(
        hashInsightSnapshot(snap(8)),
      );
      expect(hashInsightSnapshot(snap(30))).not.toBe(
        hashInsightSnapshot(snap(31)),
      );
    });

    it("keeps a null recency (no dated reading) distinct from every tier", () => {
      const noReading = hashInsightSnapshot(snap(null));
      expect(noReading).not.toBe(hashInsightSnapshot(snap(0)));
      expect(noReading).not.toBe(hashInsightSnapshot(snap(31)));
    });

    it("buckets nested *DaysAgo keys the same way (per-series, signal block)", () => {
      const fresh = hashInsightSnapshot({
        signal: { metric: "Pulse", newestDaysAgo: 3, current: 61 },
      });
      const sameTier = hashInsightSnapshot({
        signal: { metric: "Pulse", newestDaysAgo: 6, current: 61 },
      });
      const staleTier = hashInsightSnapshot({
        signal: { metric: "Pulse", newestDaysAgo: 9, current: 61 },
      });
      expect(fresh).toBe(sameTier);
      expect(fresh).not.toBe(staleTier);
    });
  });

  it("keeps absolute day keys in the fingerprint", () => {
    const a = hashInsightSnapshot({
      recent: [{ date: "2026-06-09", mean: 80 }],
    });
    const b = hashInsightSnapshot({
      recent: [{ date: "2026-06-10", mean: 80 }],
    });
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
