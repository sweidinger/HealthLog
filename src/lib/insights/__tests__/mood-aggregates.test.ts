import { describe, expect, it } from "vitest";

import {
  computeDistribution,
  computeHeatmapCells,
  computeInTargetPct,
  computeMoodAggregates,
  computeMoodMetricCorrelation,
  computeStructuredTagSummary,
  computeTagSummary,
  computeWeekdayAverages,
  selectHeatmapWindow,
  type CrossMetricMeasurement,
  type MoodAggregateEntry,
  type StructuredTagRef,
} from "../mood-aggregates";

const dayMs = 24 * 60 * 60 * 1000;

/** Anchor "now" at a fixed UTC instant so day-key math is deterministic. */
const NOW = new Date("2026-06-01T12:00:00.000Z");

function dayKey(offset: number): string {
  return new Date(NOW.getTime() - offset * dayMs).toISOString().slice(0, 10);
}

function entry(
  offset: number,
  score: number,
  tags: unknown = null,
): MoodAggregateEntry {
  const ts = new Date(NOW.getTime() - offset * dayMs);
  return { date: dayKey(offset), score, tags, moodLoggedAt: ts };
}

describe("selectHeatmapWindow", () => {
  it("uses a 30-day window below 90 days of history", () => {
    expect(selectHeatmapWindow(0)).toBe(30);
    expect(selectHeatmapWindow(45)).toBe(30);
    expect(selectHeatmapWindow(89)).toBe(30);
  });

  it("uses a 90-day window between 90 and 180 days inclusive", () => {
    expect(selectHeatmapWindow(90)).toBe(90);
    expect(selectHeatmapWindow(150)).toBe(90);
    expect(selectHeatmapWindow(180)).toBe(90);
  });

  it("uses a 365-day window beyond 180 days", () => {
    expect(selectHeatmapWindow(181)).toBe(365);
    expect(selectHeatmapWindow(400)).toBe(365);
  });
});

describe("computeTagSummary", () => {
  it("ranks tags by frequency, drops singletons, and averages the score", () => {
    const entries: MoodAggregateEntry[] = [
      entry(1, 5, ["sport", "work"]),
      entry(2, 3, ["work"]),
      entry(3, 1, ["work"]),
      entry(4, 4, ["sport"]),
      entry(5, 2, ["solo-tag"]), // count 1 → dropped
    ];
    const tags = computeTagSummary(entries, NOW);
    expect(tags).toEqual([
      { tag: "work", count: 3, avgScore: 3 },
      { tag: "sport", count: 2, avgScore: 4.5 },
    ]);
  });

  it("excludes entries older than the window", () => {
    const entries: MoodAggregateEntry[] = [
      entry(1, 5, ["recent"]),
      entry(2, 5, ["recent"]),
      entry(200, 5, ["old"]),
      entry(201, 5, ["old"]),
    ];
    const tags = computeTagSummary(entries, NOW, 90);
    expect(tags.map((t) => t.tag)).toEqual(["recent"]);
  });
});

describe("computeStructuredTagSummary", () => {
  function entryWithStructured(
    offset: number,
    score: number,
    structuredTags: StructuredTagRef[],
  ): MoodAggregateEntry {
    return { ...entry(offset, score, null), structuredTags };
  }

  it("ranks structured tags by frequency, keeps singletons, and groups by category", () => {
    const entries: MoodAggregateEntry[] = [
      entryWithStructured(1, 5, [
        { key: "happy", categoryKey: "feelings", labelKey: "mood.tag.happy", icon: "Smile" },
        { key: "worked_out", categoryKey: "health", labelKey: "mood.tag.workedOut", icon: "Dumbbell" },
      ]),
      entryWithStructured(2, 3, [
        { key: "happy", categoryKey: "feelings", labelKey: "mood.tag.happy", icon: "Smile" },
      ]),
      entryWithStructured(3, 1, [
        { key: "stressed", categoryKey: "feelings", labelKey: "mood.tag.stressed", icon: "Brain" },
      ]),
    ];
    const rows = computeStructuredTagSummary(entries, NOW);
    const happy = rows.find((r) => r.key === "happy");
    expect(happy).toEqual({
      key: "happy",
      categoryKey: "feelings",
      labelKey: "mood.tag.happy",
      icon: "Smile",
      count: 2,
      avgScore: 4,
    });
    // singletons are kept for the structured breakdown (curated catalog,
    // not noisy free text).
    expect(rows.find((r) => r.key === "stressed")?.count).toBe(1);
    expect(rows.find((r) => r.key === "worked_out")?.categoryKey).toBe("health");
    // ranked by frequency desc.
    expect(rows[0].key).toBe("happy");
  });

  it("excludes entries older than the window and ignores entries without structured tags", () => {
    const entries: MoodAggregateEntry[] = [
      entryWithStructured(1, 5, [
        { key: "happy", categoryKey: "feelings", labelKey: "mood.tag.happy", icon: "Smile" },
      ]),
      entryWithStructured(200, 5, [
        { key: "sad", categoryKey: "feelings", labelKey: "mood.tag.sad", icon: "Frown" },
      ]),
      entry(2, 4, ["flat-only"]), // no structuredTags → ignored here
    ];
    const rows = computeStructuredTagSummary(entries, NOW, 90);
    expect(rows.map((r) => r.key)).toEqual(["happy"]);
  });
});

describe("computeInTargetPct", () => {
  it("returns the share of the newest 30 daily buckets in the green band", () => {
    const daily = [
      { dayOffset: 0, value: 4 },
      { dayOffset: 1, value: 3 }, // below 3.5 → out
      { dayOffset: 2, value: 5 },
      { dayOffset: 3, value: 3.5 }, // exactly green min → in
    ];
    // 3 of 4 in target → 75
    expect(computeInTargetPct(daily)).toBe(75);
  });

  it("ignores buckets older than 30 days and returns null when empty", () => {
    expect(computeInTargetPct([{ dayOffset: 40, value: 5 }])).toBeNull();
    expect(computeInTargetPct([])).toBeNull();
  });
});

describe("computeDistribution", () => {
  it("rounds daily means to discrete levels and reports every level 1..5", () => {
    const daily = [
      { dayOffset: 0, value: 5 },
      { dayOffset: 1, value: 4.4 }, // → 4
      { dayOffset: 2, value: 3.6 }, // → 4
      { dayOffset: 3, value: 1 },
    ];
    expect(computeDistribution(daily)).toEqual([
      { score: 1, count: 1 },
      { score: 2, count: 0 },
      { score: 3, count: 0 },
      { score: 4, count: 2 },
      { score: 5, count: 1 },
    ]);
  });
});

describe("computeWeekdayAverages", () => {
  it("groups daily means by Monday-aligned weekday", () => {
    // 2026-06-01 is a Monday (UTC). dayOffset 0 = Mon, 1 = Sun, 7 = Mon.
    const daily = [
      { dayOffset: 0, value: 4 }, // Mon
      { dayOffset: 7, value: 2 }, // Mon
      { dayOffset: 1, value: 5 }, // Sun
    ];
    const rows = computeWeekdayAverages(daily, NOW);
    const mon = rows.find((r) => r.weekday === 0);
    const sun = rows.find((r) => r.weekday === 6);
    expect(mon).toEqual({ weekday: 0, avgScore: 3, count: 2 });
    expect(sun).toEqual({ weekday: 6, avgScore: 5, count: 1 });
    // every weekday present
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.weekday === 2)).toEqual({
      weekday: 2,
      avgScore: null,
      count: 0,
    });
  });
});

describe("computeHeatmapCells", () => {
  it("averages multi-entry days and clips to the window", () => {
    const entries: MoodAggregateEntry[] = [
      entry(0, 4),
      { ...entry(0, 2), moodLoggedAt: new Date(NOW.getTime() - 0.1 * dayMs) },
      entry(5, 1),
      entry(45, 3), // outside a 30-day window
    ];
    const cells = computeHeatmapCells(entries, NOW, 30);
    const today = cells.find((c) => c.date === dayKey(0));
    expect(today).toEqual({ date: dayKey(0), score: 3, samples: 2 });
    // The 45-day-old entry is clipped.
    expect(cells.find((c) => c.date === dayKey(45))).toBeUndefined();
    // Sorted ascending by date.
    expect(cells.map((c) => c.date)).toEqual(
      [...cells.map((c) => c.date)].sort(),
    );
  });
});

describe("computeMoodMetricCorrelation", () => {
  it("pairs on dayOffset and returns scatter points + a coefficient", () => {
    const moodDaily = [
      { dayOffset: 0, value: 5 },
      { dayOffset: 1, value: 4 },
      { dayOffset: 2, value: 3 },
      { dayOffset: 3, value: 2 },
      { dayOffset: 4, value: 1 },
    ];
    // Perfectly positively correlated metric.
    const metricDaily = moodDaily.map((b) => ({
      dayOffset: b.dayOffset,
      value: b.value * 10,
    }));
    const corr = computeMoodMetricCorrelation(moodDaily, metricDaily, NOW);
    expect(corr.n).toBe(5);
    expect(corr.points).toHaveLength(5);
    expect(corr.result?.r).toBe(1);
    expect(corr.points[0]).toEqual({ x: 5, y: 50 });
  });

  it("returns a null coefficient below the minimum pair count", () => {
    const moodDaily = [
      { dayOffset: 0, value: 5 },
      { dayOffset: 1, value: 4 },
    ];
    const metricDaily = [{ dayOffset: 0, value: 1 }];
    const corr = computeMoodMetricCorrelation(moodDaily, metricDaily, NOW);
    expect(corr.n).toBe(1);
    expect(corr.result).toBeNull();
  });
});

describe("computeMoodAggregates", () => {
  it("assembles every dimension and derives the summary headline", () => {
    const entries: MoodAggregateEntry[] = [];
    for (let day = 0; day < 200; day++) {
      entries.push(entry(day, ((day % 5) + 1) as number, ["daily"]));
    }
    // oldest-first ordering (matches the DB read .reverse()).
    entries.reverse();

    const measurements: CrossMetricMeasurement[] = [];
    for (let day = 0; day < 10; day++) {
      measurements.push({
        type: "PULSE",
        value: 60 + day,
        measuredAt: new Date(NOW.getTime() - day * dayMs),
      });
    }

    const agg = computeMoodAggregates({ entries, measurements, now: NOW });

    // 200 days of history → 365-day heatmap window.
    expect(agg.heatmap.windowDays).toBe(365);
    expect(agg.summary.totalEntries).toBe(200);
    expect(agg.summary.totalSpanDays).toBe(199);
    expect(agg.distribution).toHaveLength(5);
    expect(agg.weekday).toHaveLength(7);
    expect(agg.tags.map((t) => t.tag)).toContain("daily");
    expect(agg.correlations.pulse.n).toBeGreaterThanOrEqual(5);
    // No sleep / steps rows supplied → empty correlation.
    expect(agg.correlations.sleep.n).toBe(0);
    expect(agg.correlations.sleep.result).toBeNull();
    // v1.8.6 — the narrative feed rides on the same aggregates and is
    // ranked strongest-first.
    expect(Array.isArray(agg.narratives)).toBe(true);
    for (let i = 1; i < agg.narratives.length; i++) {
      expect(agg.narratives[i - 1].strength).toBeGreaterThanOrEqual(
        agg.narratives[i].strength,
      );
    }
  });

  it("handles an empty entry set without throwing", () => {
    const agg = computeMoodAggregates({
      entries: [],
      measurements: [],
      now: NOW,
    });
    expect(agg.summary.totalEntries).toBe(0);
    expect(agg.summary.mean).toBeNull();
    expect(agg.heatmap.windowDays).toBe(30);
    expect(agg.heatmap.cells).toEqual([]);
    expect(agg.distribution.every((d) => d.count === 0)).toBe(true);
  });
});
