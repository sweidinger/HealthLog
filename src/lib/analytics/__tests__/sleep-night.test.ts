import { describe, it, expect } from "vitest";
import type { SleepStage } from "@/generated/prisma/client";
import {
  reconstructSleepNights,
  summarizeSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";

/** Build a stage row with a fixed wall-clock instant. */
function row(
  iso: string,
  stage: SleepStage | null,
  minutes: number,
): SleepStageRow {
  return { measuredAt: new Date(iso), sleepStage: stage, value: minutes };
}

describe("reconstructSleepNights", () => {
  it("sums asleep stages into one night, excluding IN_BED + AWAKE", () => {
    // One night written as five per-stage rows (WHOOP / Apple shape), all
    // on the same UTC calendar day so the night-key collapses them.
    const rows: SleepStageRow[] = [
      row("2026-06-04T00:00:00.000Z", "IN_BED", 480),
      row("2026-06-04T00:30:00.000Z", "CORE", 240),
      row("2026-06-04T02:00:00.000Z", "DEEP", 90),
      row("2026-06-04T04:00:00.000Z", "REM", 80),
      row("2026-06-04T05:00:00.000Z", "AWAKE", 20),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    const main = nights[0];
    expect(main.night).toBe("2026-06-04");
    // Time asleep = CORE + DEEP + REM = 240 + 90 + 80 = 410. AWAKE excluded.
    expect(main.asleepMinutes).toBe(410);
    // AWAKE recorded but not counted as asleep.
    expect(main.awakeMinutes).toBe(20);
    // IN_BED row present → in-bed total surfaced.
    expect(main.inBedMinutes).toBe(480);
    expect(main.stages.CORE).toBe(240);
    expect(main.stages.DEEP).toBe(90);
    expect(main.stages.REM).toBe(80);
  });

  it("groups all stages of one night by the user's tz calendar day", () => {
    // In a non-UTC zone (Auckland = UTC+12 in June) a night whose stages
    // straddle UTC midnight still collapses to one local day. These
    // instants are all 2026-06-04 LOCAL (12:00–17:00 UTC = 00:00–05:00
    // Jun 4 Auckland) but straddle UTC midnight if keyed naively.
    const rows: SleepStageRow[] = [
      row("2026-06-03T12:00:00.000Z", "IN_BED", 480), // 00:00 Jun 4 NZST
      row("2026-06-03T13:00:00.000Z", "CORE", 240), // 01:00 Jun 4
      row("2026-06-03T15:00:00.000Z", "DEEP", 90), // 03:00 Jun 4
      row("2026-06-03T17:00:00.000Z", "REM", 80), // 05:00 Jun 4
    ];
    const nights = reconstructSleepNights(rows, "Pacific/Auckland");
    expect(nights).toHaveLength(1);
    expect(nights[0].night).toBe("2026-06-04");
    expect(nights[0].asleepMinutes).toBe(410);
    expect(nights[0].inBedMinutes).toBe(480);
  });

  it("treats a bare SLEEP_DURATION row (no stage) as the night total", () => {
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", null, 423),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    expect(nights[0].asleepMinutes).toBe(423);
    expect(nights[0].inBedMinutes).toBeNull();
  });
});

describe("summarizeSleepNights", () => {
  it("summarises per-night totals, not per-stage rows", () => {
    const rows: SleepStageRow[] = [
      // Night A — 2026-06-03: 200 + 100 = 300 asleep min.
      row("2026-06-03T01:00:00.000Z", "CORE", 200),
      row("2026-06-03T03:00:00.000Z", "DEEP", 100),
      // Night B — 2026-06-04: 240 + 90 + 90 = 420 asleep min.
      row("2026-06-04T01:00:00.000Z", "CORE", 240),
      row("2026-06-04T03:00:00.000Z", "DEEP", 90),
      row("2026-06-04T04:30:00.000Z", "REM", 90),
    ];
    const { summary, latestNight } = summarizeSleepNights(rows, "UTC");
    // count = nights, NOT stage rows (5).
    expect(summary.count).toBe(2);
    // latest = most-recent night total (minutes), not a single stage.
    expect(summary.latest).toBe(420);
    expect(summary.min).toBe(300);
    expect(summary.max).toBe(420);
    expect(summary.mean).toBe(360);
    expect(latestNight?.night).toBe("2026-06-04");
    expect(latestNight?.asleepMinutes).toBe(420);
  });

  it("drops nights with zero asleep minutes (IN_BED / AWAKE only)", () => {
    const rows: SleepStageRow[] = [
      row("2026-06-03T23:00:00.000Z", "IN_BED", 60),
      row("2026-06-03T23:30:00.000Z", "AWAKE", 60),
    ];
    const { summary, latestNight } = summarizeSleepNights(rows, "UTC");
    expect(summary.count).toBe(0);
    expect(latestNight).toBeNull();
  });

  it("returns an empty summary for no rows", () => {
    const { summary, latestNight } = summarizeSleepNights([], "UTC");
    expect(summary.count).toBe(0);
    expect(summary.latest).toBeNull();
    expect(latestNight).toBeNull();
  });
});
