import { describe, it, expect } from "vitest";

import { getServerTranslator } from "@/lib/i18n/server-translator";
import { detectStreak, type StreakPoint } from "@/lib/insights/streak-detector";
import {
  MILESTONE_KINDS,
  milestoneCopy,
  milestoneFromRecord,
  milestoneHref,
  milestonesFromStreak,
  selectFreshMilestone,
  SUSTAINED_WEEK_THRESHOLDS,
  type Milestone,
} from "@/lib/daily/milestones";

const t = getServerTranslator("en").t;

/** Build a consecutive-day UTC series ending at `endDay` (values[last] === endDay). */
function seriesEndingAt(values: number[], endDay: string): StreakPoint[] {
  const endSerial =
    Date.UTC(...(dayParts(endDay) as [number, number, number])) / 86_400_000;
  return values.map((value, i) => ({
    day: keyFromSerial(endSerial - (values.length - 1 - i)),
    value,
  }));
}

function dayParts(key: string): number[] {
  const [y, m, d] = key.split("-").map(Number);
  return [y, m - 1, d];
}

function keyFromSerial(serial: number): string {
  return new Date(serial * 86_400_000).toISOString().slice(0, 10);
}

function shift(day: string, delta: number): string {
  const serial =
    Date.UTC(...(dayParts(day) as [number, number, number])) / 86_400_000;
  return keyFromSerial(serial + delta);
}

const TODAY = "2026-07-16";

describe("milestonesFromStreak — folds the real detectStreak engine", () => {
  it("emits a fresh sustained_in_range milestone the day a week boundary is reached", () => {
    // Exactly 7 consecutive in-band days ending today → the 1-week durable
    // state is REACHED today. Uses the real detectStreak result, not a stub.
    const series = seriesEndingAt([60, 60, 60, 60, 60, 60, 60], TODAY);
    const result = detectStreak(series);
    expect(result.inBand).toBe(true);
    expect(result.streakDays).toBe(7);

    const milestones = milestonesFromStreak(
      "RESTING_HEART_RATE",
      result,
      TODAY,
    );
    const week1 = milestones.find((m) => m.copyKey.endsWith("week1"));
    expect(week1).toBeDefined();
    expect(week1?.kind).toBe("sustained_in_range");
    expect(week1?.sinceDate).toBe(TODAY); // reached today → fresh

    // Reached-once: the same durable state is NOT fresh the next day.
    expect(selectFreshMilestone(milestones, TODAY)?.copyKey).toContain("week1");
    expect(selectFreshMilestone(milestones, shift(TODAY, 1))).toBeNull();
  });

  it("does not re-fire a week boundary reached on an earlier day", () => {
    // 8 in-band days: the 1-week state was reached YESTERDAY (streak 8 > 7).
    const series = seriesEndingAt([60, 60, 60, 60, 60, 60, 60, 60], TODAY);
    const result = detectStreak(series);
    expect(result.streakDays).toBe(8);

    const milestones = milestonesFromStreak(
      "RESTING_HEART_RATE",
      result,
      TODAY,
    );
    const week1 = milestones.find((m) => m.copyKey.endsWith("week1"));
    expect(week1?.sinceDate).toBe(shift(TODAY, -1)); // reached yesterday
    expect(selectFreshMilestone(milestones, TODAY)).toBeNull(); // not fresh today
  });

  it("emits a fresh return_to_baseline the day the return settles (daysInside === MIN_IN_RUN)", () => {
    // Prior out-of-band run (90s) then a settled 2-day in-band run ending today.
    const series = seriesEndingAt(
      [60, 60, 60, 60, 60, 90, 90, 90, 60, 60],
      TODAY,
    );
    const result = detectStreak(series);
    expect(result.returnEvent).toBeDefined();
    expect(result.returnEvent?.daysInside).toBe(2);

    const milestones = milestonesFromStreak(
      "RESTING_HEART_RATE",
      result,
      TODAY,
    );
    const ret = milestones.find((m) => m.kind === "return_to_baseline");
    expect(ret).toBeDefined();
    expect(ret?.sinceDate).toBe(TODAY);
    expect(selectFreshMilestone(milestones, TODAY)?.kind).toBe(
      "return_to_baseline",
    );
    // Reached-once: gone the next day.
    expect(selectFreshMilestone(milestones, shift(TODAY, 1))).toBeNull();
  });

  it("emits NOTHING while the metric is currently out of band — no 'broken' state", () => {
    // Latest placement is out-of-band (a lapse). A lapse is invisible: no
    // milestone at all, and certainly no negative one.
    const series = seriesEndingAt([60, 60, 60, 60, 60, 60, 60, 90, 90], TODAY);
    const result = detectStreak(series);
    expect(result.inBand).toBe(false);
    expect(milestonesFromStreak("RESTING_HEART_RATE", result, TODAY)).toEqual(
      [],
    );
  });

  it("omits quietly for an empty series (no band, no guess)", () => {
    const result = detectStreak([]);
    expect(result.latestPlacement).toBeNull();
    expect(milestonesFromStreak("WEIGHT", result, TODAY)).toEqual([]);
  });

  it("emits no milestone from an in-band run shorter than a week", () => {
    // A short in-band run (3 days) has reached no durable week boundary yet.
    const series = seriesEndingAt([60, 60, 60], TODAY);
    const result = detectStreak(series);
    expect(result.inBand).toBe(true);
    expect(result.streakDays).toBe(3);
    expect(milestonesFromStreak("WEIGHT", result, TODAY)).toEqual([]);
  });
});

describe("milestoneFromRecord — folds a PersonalRecord achieved day", () => {
  it("is fresh only on the day the record was achieved", () => {
    const m = milestoneFromRecord("HEART_RATE_VARIABILITY", TODAY);
    expect(m.kind).toBe("record_first");
    expect(selectFreshMilestone([m], TODAY)?.kind).toBe("record_first");
    expect(selectFreshMilestone([m], shift(TODAY, 1))).toBeNull();
  });
});

describe("selectFreshMilestone — reached-once, one per day, most meaningful", () => {
  it("prefers a personal best, then a return, then a sustained state", () => {
    const record: Milestone = milestoneFromRecord("RESTING_HEART_RATE", TODAY);
    const ret: Milestone = {
      kind: "return_to_baseline",
      metricType: "WEIGHT",
      sinceDate: TODAY,
      copyKey: "daily.milestone.returnToBaseline",
    };
    const sustained: Milestone = {
      kind: "sustained_in_range",
      metricType: "WEIGHT",
      sinceDate: TODAY,
      copyKey: "daily.milestone.sustainedInRange.week1",
    };
    expect(selectFreshMilestone([sustained, ret, record], TODAY)?.kind).toBe(
      "record_first",
    );
    expect(selectFreshMilestone([sustained, ret], TODAY)?.kind).toBe(
      "return_to_baseline",
    );
    expect(selectFreshMilestone([sustained], TODAY)?.kind).toBe(
      "sustained_in_range",
    );
  });

  it("returns null when no candidate was reached today", () => {
    const stale: Milestone = milestoneFromRecord("WEIGHT", shift(TODAY, -3));
    expect(selectFreshMilestone([stale], TODAY)).toBeNull();
    expect(selectFreshMilestone([], TODAY)).toBeNull();
  });
});

describe("copy is calm and never negative", () => {
  const cases: Milestone[] = [
    milestoneFromRecord("RESTING_HEART_RATE", TODAY),
    {
      kind: "return_to_baseline",
      metricType: "RESTING_HEART_RATE",
      sinceDate: TODAY,
      copyKey: "daily.milestone.returnToBaseline",
    },
    ...SUSTAINED_WEEK_THRESHOLDS.map((w): Milestone => ({
      kind: "sustained_in_range",
      metricType: "RESTING_HEART_RATE",
      sinceDate: TODAY,
      copyKey: `daily.milestone.sustainedInRange.week${w}`,
    })),
  ];

  it("resolves a real title + body with the metric name interpolated, no leftover placeholder", () => {
    for (const m of cases) {
      const { title, body } = milestoneCopy(m, t);
      expect(title.length).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
      expect(title).not.toContain("{metric}");
      expect(body).not.toContain("{metric}");
      expect(body.toLowerCase()).toContain("resting heart rate");
    }
  });

  it("uses no streak / loss / failure vocabulary anywhere", () => {
    const forbidden =
      /streak|flame|broke|broken|lost|don'?t lose|missed|fail|penalt/i;
    for (const m of cases) {
      const { title, body } = milestoneCopy(m, t);
      expect(title).not.toMatch(forbidden);
      expect(body).not.toMatch(forbidden);
    }
  });

  it("every milestone deep-links to an insight surface", () => {
    for (const m of cases) {
      expect(milestoneHref(m)).toMatch(/^\/insights/);
    }
  });
});

describe("the type carries no running counter", () => {
  it("a Milestone has only kind / metricType / sinceDate / copyKey", () => {
    const m = milestoneFromRecord("WEIGHT", TODAY);
    expect(Object.keys(m).sort()).toEqual([
      "copyKey",
      "kind",
      "metricType",
      "sinceDate",
    ]);
  });

  it("exposes exactly the three durable kinds", () => {
    expect([...MILESTONE_KINDS]).toEqual([
      "record_first",
      "return_to_baseline",
      "sustained_in_range",
    ]);
  });
});
