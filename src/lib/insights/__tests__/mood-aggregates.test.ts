import { describe, expect, it } from "vitest";

import {
  STABILITY_MIN_DAYS,
  STABILITY_SD_FULL_SCALE,
  TIME_OF_DAY_MIN_BUCKET_SAMPLES,
  bucketForHour,
  computeDistribution,
  computeHeatmapCells,
  computeInTargetPct,
  computeMoodAggregates,
  computeMoodMetricCorrelation,
  computeMoodStability,
  computeStructuredTagSummary,
  computeTagSummary,
  computeTimeOfDayAverages,
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

  it("carries the time-of-day pattern and stability fields", () => {
    const agg = computeMoodAggregates({
      entries: [],
      measurements: [],
      now: NOW,
    });
    expect(agg.timeOfDay.reliable).toBe(false);
    expect(agg.timeOfDay.buckets.map((b) => b.bucket)).toEqual([
      "morning",
      "afternoon",
      "evening",
      "night",
    ]);
    expect(agg.stability).toBeNull();
  });
});

describe("bucketForHour", () => {
  it("maps each hour to its part of day with night wrapping midnight", () => {
    expect(bucketForHour(0)).toBe("night");
    expect(bucketForHour(4)).toBe("night");
    expect(bucketForHour(5)).toBe("morning");
    expect(bucketForHour(11)).toBe("morning");
    expect(bucketForHour(12)).toBe("afternoon");
    expect(bucketForHour(16)).toBe("afternoon");
    expect(bucketForHour(17)).toBe("evening");
    expect(bucketForHour(20)).toBe("evening");
    expect(bucketForHour(21)).toBe("night");
    expect(bucketForHour(23)).toBe("night");
  });
});

describe("computeTimeOfDayAverages", () => {
  /** Build an entry at a fixed UTC instant + hour, in a given tz. */
  function tzEntry(
    daysAgo: number,
    utcHour: number,
    score: number,
    tz: string | null = "UTC",
  ): MoodAggregateEntry {
    const base = new Date(NOW.getTime() - daysAgo * dayMs);
    base.setUTCHours(utcHour, 0, 0, 0);
    return { date: dayKey(daysAgo), score, tags: null, moodLoggedAt: base, tz };
  }

  it("buckets entries by part of day and averages per bucket", () => {
    const entries: MoodAggregateEntry[] = [
      tzEntry(1, 8, 5),
      tzEntry(2, 9, 3),
      tzEntry(3, 14, 4),
      tzEntry(4, 14, 2),
    ];
    const pattern = computeTimeOfDayAverages(entries);
    const morning = pattern.buckets.find((b) => b.bucket === "morning");
    const afternoon = pattern.buckets.find((b) => b.bucket === "afternoon");
    expect(morning).toEqual({ bucket: "morning", avgScore: 4, count: 2 });
    expect(afternoon).toEqual({ bucket: "afternoon", avgScore: 3, count: 2 });
  });

  it("honours the per-row timezone when bucketing the local hour", () => {
    // 06:00 UTC is 08:00 in Berlin (summer, UTC+2) → morning, but stays
    // in the night bucket (00:00–04:59) under a UTC-6 zone.
    const berlin = computeTimeOfDayAverages([
      tzEntry(1, 6, 5, "Europe/Berlin"),
    ]);
    expect(berlin.buckets.find((b) => b.bucket === "morning")?.count).toBe(1);

    const chicago = computeTimeOfDayAverages([
      tzEntry(1, 6, 5, "America/Chicago"),
    ]);
    expect(chicago.buckets.find((b) => b.bucket === "night")?.count).toBe(1);
  });

  it("falls back to UTC for legacy rows without a tz", () => {
    const pattern = computeTimeOfDayAverages([tzEntry(1, 14, 5, null)]);
    expect(pattern.buckets.find((b) => b.bucket === "afternoon")?.count).toBe(1);
  });

  it("is unreliable for a once-a-day logger clustered in one bucket", () => {
    // Ten nightly logs, all in the evening bucket → single-bucket spread.
    const entries = Array.from({ length: 10 }, (_, i) => tzEntry(i, 19, 4));
    const pattern = computeTimeOfDayAverages(entries);
    expect(pattern.reliable).toBe(false);
    expect(pattern.best).toBeNull();
    expect(pattern.worst).toBeNull();
  });

  it("is unreliable when a second bucket is below the sample floor", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, i) => tzEntry(i, 8, 5)), // morning ≥ floor
      tzEntry(5, 14, 3), // a single afternoon log, below the floor
    ];
    expect(TIME_OF_DAY_MIN_BUCKET_SAMPLES).toBeGreaterThan(1);
    const pattern = computeTimeOfDayAverages(entries);
    expect(pattern.reliable).toBe(false);
  });

  it("surfaces best/worst once two buckets clear the sample floor", () => {
    const entries = [
      ...Array.from({ length: 4 }, (_, i) => tzEntry(i, 8, 5)), // morning avg 5
      ...Array.from({ length: 4 }, (_, i) => tzEntry(i + 4, 22, 2)), // night avg 2
    ];
    const pattern = computeTimeOfDayAverages(entries);
    expect(pattern.reliable).toBe(true);
    expect(pattern.best).toBe("morning");
    expect(pattern.worst).toBe("night");
  });
});

describe("computeMoodStability", () => {
  function points(values: number[]) {
    return values.map((value, i) => ({ dayOffset: i, value }));
  }

  it("returns null below the minimum-days floor", () => {
    const sparse = points(Array(STABILITY_MIN_DAYS - 1).fill(3));
    expect(computeMoodStability(sparse)).toBeNull();
  });

  it("scores a perfectly flat mood at 100 (very steady)", () => {
    const flat = points(Array(STABILITY_MIN_DAYS).fill(3));
    const stability = computeMoodStability(flat);
    expect(stability).not.toBeNull();
    expect(stability?.score).toBe(100);
    expect(stability?.stdDev).toBe(0);
    expect(stability?.band).toBe("verySteady");
    expect(stability?.days).toBe(STABILITY_MIN_DAYS);
  });

  it("scores an sd at or beyond the full-scale cap at 0 (very variable)", () => {
    // Alternating 1 / 5 → sd 2.0 > FULL_SCALE → clamped to 0.
    const swing = points(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 1 : 5)),
    );
    const stability = computeMoodStability(swing);
    expect(stability?.score).toBe(0);
    expect(stability?.band).toBe("veryVariable");
    expect(stability?.stdDev).toBeGreaterThanOrEqual(STABILITY_SD_FULL_SCALE);
  });

  it("scales linearly between the bounds", () => {
    // A balanced series alternating ±halfFull around its mean has a
    // population sd of exactly halfFull → score 50.
    const halfFull = STABILITY_SD_FULL_SCALE / 2;
    const balanced = points(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? 3 - halfFull : 3 + halfFull,
      ),
    );
    const stability = computeMoodStability(balanced);
    expect(stability?.stdDev).toBe(halfFull);
    expect(stability?.score).toBe(50);
    expect(stability?.band).toBe("variable");
  });
});
