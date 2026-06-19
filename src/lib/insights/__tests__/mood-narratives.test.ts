import { describe, expect, it } from "vitest";

import {
  MOOD_NARRATIVE_MIN_DAYS,
  MOOD_NARRATIVE_MIN_EFFECT,
  MOOD_NARRATIVE_MIN_WEEKDAY_SAMPLES,
  MOOD_NARRATIVE_MIN_TAG_COUNT,
  MOOD_NARRATIVE_TREND_WINDOW,
  MOOD_NARRATIVE_MIN_STREAK,
  MOOD_NARRATIVE_MAX_ITEMS,
  computeMoodNarratives,
  type MoodNarrativeInput,
} from "../mood-narratives";

const dayMs = 24 * 60 * 60 * 1000;
/** 2026-06-01 is a Monday in UTC. */
const NOW = new Date("2026-06-01T12:00:00.000Z");

function daily(values: Array<{ dayOffset: number; value: number }>) {
  return values;
}

/** A baseline input that clears nothing — every takeaway silent. */
function emptyInput(): MoodNarrativeInput {
  return {
    daily: [],
    weekday: [],
    timeOfDay: { buckets: [], reliable: false, best: null, worst: null },
    tags: [],
    structuredTags: [],
    inTargetPct: null,
    loggedDayKeys: [],
    now: NOW,
  };
}

describe("computeMoodNarratives — anti-platitude thresholds", () => {
  it("returns nothing for an empty input set", () => {
    expect(computeMoodNarratives(emptyInput())).toEqual([]);
  });

  it("stays silent on the weekday dip when the effect is below the min", () => {
    // Mon avg 3.4 vs overall ~3.5 → delta < MIN_EFFECT, no fire.
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      weekday: [
        { weekday: 0, avgScore: 3.45, count: 5 },
        { weekday: 1, avgScore: 3.5, count: 5 },
        { weekday: 2, avgScore: 3.55, count: 5 },
      ],
    };
    const out = computeMoodNarratives(input);
    expect(out.find((n) => n.kind === "weekday-dip")).toBeUndefined();
  });

  it("fires the weekday dip only above the effect threshold", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      weekday: [
        { weekday: 0, avgScore: 2.5, count: 5 }, // Monday, clearly low
        { weekday: 1, avgScore: 4.5, count: 5 },
        { weekday: 2, avgScore: 4.5, count: 5 },
      ],
    };
    const out = computeMoodNarratives(input);
    const dip = out.find((n) => n.kind === "weekday-dip");
    expect(dip).toBeDefined();
    expect(dip?.vars.weekdayKey).toBe("charts.weekdaysFull.mon");
    // delta is the gap below the weekly mean, a positive magnitude.
    expect(Number(dip?.vars.delta)).toBeGreaterThanOrEqual(
      MOOD_NARRATIVE_MIN_EFFECT,
    );
  });

  it("stays silent on the weekday dip when no weekday clears the sample gate", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      weekday: [
        {
          weekday: 0,
          avgScore: 2.5,
          count: MOOD_NARRATIVE_MIN_WEEKDAY_SAMPLES - 1,
        },
        {
          weekday: 1,
          avgScore: 4.5,
          count: MOOD_NARRATIVE_MIN_WEEKDAY_SAMPLES - 1,
        },
      ],
    };
    expect(
      computeMoodNarratives(input).find((n) => n.kind === "weekday-dip"),
    ).toBeUndefined();
  });

  it("fires the trend takeaway only when the window means differ by the threshold", () => {
    // Recent window high, prior window low → upward trend.
    const recent = Array.from(
      { length: MOOD_NARRATIVE_TREND_WINDOW },
      (_, i) => ({
        dayOffset: i,
        value: 5,
      }),
    );
    const prior = Array.from(
      { length: MOOD_NARRATIVE_TREND_WINDOW },
      (_, i) => ({
        dayOffset: i + MOOD_NARRATIVE_TREND_WINDOW,
        value: 2,
      }),
    );
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      daily: daily([...recent, ...prior]),
    };
    const trend = computeMoodNarratives(input).find((n) => n.kind === "trend");
    expect(trend).toBeDefined();
    expect(trend?.vars.direction).toBe("up");
  });

  it("stays silent on the trend when the change is below the effect threshold", () => {
    const recent = Array.from(
      { length: MOOD_NARRATIVE_TREND_WINDOW },
      (_, i) => ({
        dayOffset: i,
        value: 3.5,
      }),
    );
    const prior = Array.from(
      { length: MOOD_NARRATIVE_TREND_WINDOW },
      (_, i) => ({
        dayOffset: i + MOOD_NARRATIVE_TREND_WINDOW,
        value: 3.55,
      }),
    );
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      daily: daily([...recent, ...prior]),
    };
    expect(
      computeMoodNarratives(input).find((n) => n.kind === "trend"),
    ).toBeUndefined();
  });

  it("stays silent on the trend below the minimum window sample size", () => {
    const recent = Array.from(
      { length: MOOD_NARRATIVE_TREND_WINDOW - 1 },
      (_, i) => ({
        dayOffset: i,
        value: 5,
      }),
    );
    const prior = Array.from(
      { length: MOOD_NARRATIVE_TREND_WINDOW - 1 },
      (_, i) => ({
        dayOffset: i + MOOD_NARRATIVE_TREND_WINDOW,
        value: 2,
      }),
    );
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      daily: daily([...recent, ...prior]),
    };
    expect(
      computeMoodNarratives(input).find((n) => n.kind === "trend"),
    ).toBeUndefined();
  });

  it("fires a tag-lift takeaway only above the count and effect gates", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      // overall mean from daily is ~3
      daily: daily([
        { dayOffset: 0, value: 3 },
        { dayOffset: 1, value: 3 },
        { dayOffset: 2, value: 3 },
      ]),
      tags: [
        { tag: "sport", count: MOOD_NARRATIVE_MIN_TAG_COUNT, avgScore: 4.5 },
        { tag: "rare", count: MOOD_NARRATIVE_MIN_TAG_COUNT - 1, avgScore: 5 },
      ],
    };
    const out = computeMoodNarratives(input);
    const lift = out.find((n) => n.kind === "tag-lift");
    expect(lift?.vars.tag).toBe("sport");
    // the under-count tag never fires
    expect(out.some((n) => n.vars.tag === "rare")).toBe(false);
  });

  it("fires a tag-drop takeaway for tags well below the overall mean", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      daily: daily([
        { dayOffset: 0, value: 4 },
        { dayOffset: 1, value: 4 },
        { dayOffset: 2, value: 4 },
      ]),
      tags: [{ tag: "work", count: MOOD_NARRATIVE_MIN_TAG_COUNT, avgScore: 2 }],
    };
    const drop = computeMoodNarratives(input).find(
      (n) => n.kind === "tag-drop",
    );
    expect(drop?.vars.tag).toBe("work");
    expect(Number(drop?.vars.delta)).toBeGreaterThanOrEqual(
      MOOD_NARRATIVE_MIN_EFFECT,
    );
  });

  it("surfaces a structured tag→mood lift via its catalog label key", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      daily: daily([
        { dayOffset: 0, value: 3 },
        { dayOffset: 1, value: 3 },
        { dayOffset: 2, value: 3 },
      ]),
      structuredTags: [
        {
          key: "happy",
          categoryKey: "feelings",
          labelKey: "insights.mood.tags.feelings.happy",
          icon: null,
          count: MOOD_NARRATIVE_MIN_TAG_COUNT,
          avgScore: 4.5,
        },
      ],
    };
    const out = computeMoodNarratives(input);
    const lift = out.find((n) => n.kind === "tag-lift");
    // structured tags carry an i18n key the renderer resolves, never a
    // raw label string.
    expect(lift?.vars.tagKey).toBe("insights.mood.tags.feelings.happy");
    expect(lift?.vars.tag).toBeUndefined();
  });

  it("surfaces a custom structured tag via its decrypted label, never the raw key", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      daily: daily([
        { dayOffset: 0, value: 3 },
        { dayOffset: 1, value: 3 },
        { dayOffset: 2, value: 3 },
      ]),
      structuredTags: [
        {
          key: "custom:abc-123",
          categoryKey: "custom",
          // A custom tag's labelKey mirrors its raw key — t() cannot
          // resolve it, so the takeaway must carry the decrypted label
          // verbatim instead.
          labelKey: "custom:abc-123",
          label: "Migraine",
          icon: "Tag",
          count: MOOD_NARRATIVE_MIN_TAG_COUNT,
          avgScore: 1.5,
        },
      ],
    };
    const out = computeMoodNarratives(input);
    const drop = out.find((n) => n.kind === "tag-drop");
    expect(drop?.vars.tag).toBe("Migraine");
    expect(drop?.vars.tagKey).toBeUndefined();
  });

  it("ranks flat and structured tags in one shared pool", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      daily: daily([
        { dayOffset: 0, value: 3 },
        { dayOffset: 1, value: 3 },
        { dayOffset: 2, value: 3 },
      ]),
      tags: [
        { tag: "sport", count: MOOD_NARRATIVE_MIN_TAG_COUNT, avgScore: 4 },
      ],
      structuredTags: [
        {
          key: "celebrating",
          categoryKey: "events",
          labelKey: "insights.mood.tags.events.celebrating",
          icon: null,
          count: MOOD_NARRATIVE_MIN_TAG_COUNT,
          avgScore: 5, // stronger lift than the flat "sport" tag
        },
      ],
    };
    const lift = computeMoodNarratives(input).find(
      (n) => n.kind === "tag-lift",
    );
    // the stronger structured lift wins the single tag-lift slot.
    expect(lift?.vars.tagKey).toBe("insights.mood.tags.events.celebrating");
  });

  it("ignores a structured tag below the occurrence gate", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      daily: daily([
        { dayOffset: 0, value: 3 },
        { dayOffset: 1, value: 3 },
      ]),
      structuredTags: [
        {
          key: "rare",
          categoryKey: "events",
          labelKey: "insights.mood.tags.events.rare",
          icon: null,
          count: MOOD_NARRATIVE_MIN_TAG_COUNT - 1,
          avgScore: 5,
        },
      ],
    };
    const out = computeMoodNarratives(input);
    expect(out.some((n) => n.kind === "tag-lift")).toBe(false);
  });

  it("stays silent on a tag whose delta is below the effect threshold", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      daily: daily([
        { dayOffset: 0, value: 3 },
        { dayOffset: 1, value: 3 },
      ]),
      tags: [{ tag: "neutral", count: 10, avgScore: 3.1 }],
    };
    const out = computeMoodNarratives(input);
    expect(out.some((n) => n.vars.tag === "neutral")).toBe(false);
  });

  it("surfaces the in-target share once data exists", () => {
    const input: MoodNarrativeInput = { ...emptyInput(), inTargetPct: 72 };
    const it = computeMoodNarratives(input).find((n) => n.kind === "in-target");
    expect(it?.vars.pct).toBe("72");
  });

  it("stays silent on in-target when there is no recent data", () => {
    expect(
      computeMoodNarratives(emptyInput()).find((n) => n.kind === "in-target"),
    ).toBeUndefined();
  });

  it("fires the streak takeaway only at or above the minimum run", () => {
    const keys = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        new Date(NOW.getTime() - i * dayMs).toISOString().slice(0, 10),
      );
    const below: MoodNarrativeInput = {
      ...emptyInput(),
      loggedDayKeys: keys(MOOD_NARRATIVE_MIN_STREAK - 1),
    };
    expect(
      computeMoodNarratives(below).find((n) => n.kind === "streak"),
    ).toBeUndefined();

    const above: MoodNarrativeInput = {
      ...emptyInput(),
      loggedDayKeys: keys(MOOD_NARRATIVE_MIN_STREAK),
    };
    const streak = computeMoodNarratives(above).find(
      (n) => n.kind === "streak",
    );
    expect(streak?.vars.days).toBe(String(MOOD_NARRATIVE_MIN_STREAK));
  });

  it("breaks the streak on a gap in consecutive days", () => {
    const today = NOW.toISOString().slice(0, 10);
    const twoDaysAgo = new Date(NOW.getTime() - 2 * dayMs)
      .toISOString()
      .slice(0, 10);
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      // today + a gap → run length 1, below the min.
      loggedDayKeys: [today, twoDaysAgo],
    };
    expect(
      computeMoodNarratives(input).find((n) => n.kind === "streak"),
    ).toBeUndefined();
  });

  it("fires the weekend effect above the effect threshold", () => {
    // Build a daily series where weekend days (Sat/Sun) score higher.
    // dayOffset 0 = Mon (NOW). offsets 5,6 = Wed/Tue back; use explicit days.
    // Sat is offset 2 (Sat May 30), Sun is offset 1 (Sun May 31).
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      daily: daily([
        { dayOffset: 0, value: 2 }, // Mon
        { dayOffset: 1, value: 5 }, // Sun
        { dayOffset: 2, value: 5 }, // Sat
        { dayOffset: 3, value: 2 }, // Fri
        { dayOffset: 4, value: 2 }, // Thu
        { dayOffset: 8, value: 5 }, // Sun prior
        { dayOffset: 9, value: 5 }, // Sat prior
      ]),
    };
    const weekend = computeMoodNarratives(input).find(
      (n) => n.kind === "weekend",
    );
    expect(weekend).toBeDefined();
    expect(weekend?.vars.direction).toBe("up");
  });
});

describe("computeMoodNarratives — ranking and capping", () => {
  it("ranks by descending strength and caps the list", () => {
    // Construct many firing signals; assert ordering by strength + cap.
    const weekday = [
      { weekday: 0, avgScore: 1, count: 5 },
      { weekday: 1, avgScore: 5, count: 5 },
      { weekday: 2, avgScore: 5, count: 5 },
    ];
    const recent = Array.from(
      { length: MOOD_NARRATIVE_TREND_WINDOW },
      (_, i) => ({
        dayOffset: i,
        value: 5,
      }),
    );
    const prior = Array.from(
      { length: MOOD_NARRATIVE_TREND_WINDOW },
      (_, i) => ({
        dayOffset: i + MOOD_NARRATIVE_TREND_WINDOW,
        value: 1,
      }),
    );
    const input: MoodNarrativeInput = {
      daily: [...recent, ...prior],
      weekday,
      timeOfDay: { buckets: [], reliable: false, best: null, worst: null },
      tags: [
        { tag: "great", count: 10, avgScore: 5 },
        { tag: "bad", count: 10, avgScore: 1 },
      ],
      structuredTags: [],
      inTargetPct: 80,
      loggedDayKeys: Array.from({ length: 10 }, (_, i) =>
        new Date(NOW.getTime() - i * dayMs).toISOString().slice(0, 10),
      ),
      now: NOW,
    };
    const out = computeMoodNarratives(input);
    expect(out.length).toBeLessThanOrEqual(MOOD_NARRATIVE_MAX_ITEMS);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].strength).toBeGreaterThanOrEqual(out[i].strength);
    }
  });

  it("exposes a stable minimum-days constant", () => {
    expect(MOOD_NARRATIVE_MIN_DAYS).toBeGreaterThan(0);
  });

  it("stays silent on time-of-day when the pattern is unreliable", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      timeOfDay: {
        // Spread is fine but the effect is computed from best/worst below.
        buckets: [
          { bucket: "morning", avgScore: 4, count: 5 },
          { bucket: "afternoon", avgScore: 4, count: 5 },
          { bucket: "evening", avgScore: null, count: 0 },
          { bucket: "night", avgScore: null, count: 0 },
        ],
        reliable: false,
        best: null,
        worst: null,
      },
    };
    expect(
      computeMoodNarratives(input).find((n) => n.kind === "time-of-day"),
    ).toBeUndefined();
  });

  it("fires the time-of-day takeaway when reliable and the effect clears the bar", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      timeOfDay: {
        buckets: [
          { bucket: "morning", avgScore: 4.5, count: 6 },
          { bucket: "afternoon", avgScore: 3.0, count: 6 },
          { bucket: "evening", avgScore: null, count: 0 },
          { bucket: "night", avgScore: null, count: 0 },
        ],
        reliable: true,
        best: "morning",
        worst: "afternoon",
      },
    };
    const item = computeMoodNarratives(input).find(
      (n) => n.kind === "time-of-day",
    );
    expect(item).toBeDefined();
    expect(item?.messageKey).toBe("insights.mood.narrative.timeOfDay");
    expect(item?.vars.bucketKey).toBe("insights.mood.timeOfDay.morning");
    expect(item?.vars.value).toBe("4.5");
  });

  it("stays silent on time-of-day when best/worst are within the effect threshold", () => {
    const input: MoodNarrativeInput = {
      ...emptyInput(),
      timeOfDay: {
        buckets: [
          { bucket: "morning", avgScore: 3.6, count: 6 },
          { bucket: "afternoon", avgScore: 3.5, count: 6 },
          { bucket: "evening", avgScore: null, count: 0 },
          { bucket: "night", avgScore: null, count: 0 },
        ],
        reliable: true,
        best: "morning",
        worst: "afternoon",
      },
    };
    expect(
      computeMoodNarratives(input).find((n) => n.kind === "time-of-day"),
    ).toBeUndefined();
  });
});
