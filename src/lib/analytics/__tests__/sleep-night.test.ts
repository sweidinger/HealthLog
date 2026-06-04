import { describe, it, expect } from "vitest";
import type {
  MeasurementSource,
  SleepStage,
} from "@/generated/prisma/client";
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

/** Build a stage row tagged with an ingest source. */
function srcRow(
  iso: string,
  stage: SleepStage | null,
  minutes: number,
  source: MeasurementSource,
): SleepStageRow {
  return { measuredAt: new Date(iso), sleepStage: stage, value: minutes, source };
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

  it("keeps a night that straddles LOCAL midnight as ONE night (HIGH)", () => {
    // Berlin = UTC+2 in June. Asleep 22:30 → 06:15 LOCAL across CONTIGUOUS
    // stage segments (each ends where the next begins). The stage END instants
    // land on BOTH sides of local midnight, so a per-stage day key would split
    // the night in two and the headline would lose the pre-midnight sleep.
    // Session clustering must collapse them into one night keyed by the LOCAL
    // WAKE DAY (Jun 4, the morning the user wakes).
    const rows: SleepStageRow[] = [
      // IN_BED spans the whole night (22:30 → 06:15 local = 465 min).
      row("2026-06-04T04:15:00.000Z", "IN_BED", 465),
      row("2026-06-03T21:30:00.000Z", "CORE", 60), //  22:30 → 23:30 Jun 3
      row("2026-06-03T23:00:00.000Z", "DEEP", 90), //  23:30 → 01:00 (→ Jun 4)
      row("2026-06-04T01:00:00.000Z", "REM", 120), //  01:00 → 03:00 Jun 4
      row("2026-06-04T04:15:00.000Z", "CORE", 195), // 03:00 → 06:15 Jun 4
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    // Keyed by the wake day, not the fall-asleep day.
    expect(nights[0].night).toBe("2026-06-04");
    // Whole night summed: CORE 60 + DEEP 90 + REM 120 + CORE 195 = 465.
    expect(nights[0].asleepMinutes).toBe(465);
    expect(nights[0].inBedMinutes).toBe(465);
  });

  it("keeps a night that straddles a DST spring-forward as one night", () => {
    // Europe/Berlin springs forward 2026-03-29 02:00 → 03:00 local (UTC+1 →
    // UTC+2). A night asleep ~23:00 Mar 28 → ~07:00 Mar 29 local crosses the
    // skipped hour. The absolute-time gap clustering is DST-immune, and the
    // wake-day key resolves on the real instant, so it stays one night keyed
    // to the wake day (Mar 29).
    // Contiguous segments chained in UTC across the spring-forward seam.
    const rows: SleepStageRow[] = [
      row("2026-03-28T22:40:00.000Z", "CORE", 100), // 23:00 → 23:40 Mar 28 (UTC+1)
      row("2026-03-29T00:30:00.000Z", "DEEP", 110), // 23:40 → 01:30 Mar 29 (UTC+1)
      // 01:55 UTC = 03:55 Mar 29 local AFTER the spring-forward (UTC+2).
      row("2026-03-29T01:55:00.000Z", "REM", 85), //   01:30 → 03:55 Mar 29 (DST seam)
      row("2026-03-29T05:00:00.000Z", "CORE", 185), // 03:55 → 07:00 Mar 29 (UTC+2)
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    expect(nights[0].night).toBe("2026-03-29");
    // 100 + 110 + 85 + 185 = 480 asleep minutes, summed across the DST seam.
    expect(nights[0].asleepMinutes).toBe(480);
  });

  it("keeps a daytime nap separable from the following overnight night", () => {
    // A 15:00 nap and a 19:40→06:00 overnight block are > 3 h apart, so they
    // are two distinct sessions — the nap is NOT lumped into the night.
    const rows: SleepStageRow[] = [
      row("2026-06-03T13:00:00.000Z", "CORE", 45), //  14:15 → 15:00 Jun 3 nap
      // Overnight, contiguous: ~19:40 Jun 3 → 06:00 Jun 4 local.
      row("2026-06-03T21:00:00.000Z", "CORE", 200), // 19:40 → 23:00 Jun 3
      row("2026-06-03T23:00:00.000Z", "DEEP", 120), // 23:00 → 01:00 Jun 4
      row("2026-06-04T01:00:00.000Z", "REM", 120), //  01:00 → 03:00 Jun 4
      row("2026-06-04T04:00:00.000Z", "CORE", 180), // 03:00 → 06:00 Jun 4
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(2);
    // Nap keyed to its own wake day (Jun 3); overnight to Jun 4.
    expect(nights[0].night).toBe("2026-06-03");
    expect(nights[0].asleepMinutes).toBe(45);
    expect(nights[1].night).toBe("2026-06-04");
    expect(nights[1].asleepMinutes).toBe(620);
  });

  it("collapses a dual-source night to one canonical source (MEDIUM-1)", () => {
    // WHOOP + Apple Health both report the SAME night. The default `sleep`
    // ladder is WHOOP > APPLE_HEALTH > WITHINGS, so only WHOOP's stages are
    // summed — no double-count, no blend.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      // Apple Health's parallel rows for the same night — must be dropped.
      srcRow("2026-06-04T01:05:00.000Z", "CORE", 230, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:05:00.000Z", "DEEP", 85, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:35:00.000Z", "REM", 80, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    // WHOOP only: 240 + 90 + 90 = 420, NOT the ~825 blend of both sources.
    expect(nights[0].asleepMinutes).toBe(420);
    expect(nights[0].stages.CORE).toBe(240);
  });

  it("honours a per-user ladder that prefers Apple Health over WHOOP", () => {
    const priorityJson = { sleep: ["APPLE_HEALTH", "WHOOP"] };
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WHOOP"),
      srcRow("2026-06-04T01:05:00.000Z", "CORE", 230, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:05:00.000Z", "DEEP", 80, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "UTC", priorityJson);
    expect(nights).toHaveLength(1);
    // Apple Health wins under the override: 230 + 80 = 310.
    expect(nights[0].asleepMinutes).toBe(310);
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

  it("the latest night is the most-recent COMPLETE midnight-spanning night", () => {
    // The headline reads `latestNight.asleepMinutes`. With a midnight-spanning
    // last night, the old per-stage keying would have made the latest "night"
    // the post-midnight fragment only. After the fix the latest night carries
    // the full asleep total.
    const rows: SleepStageRow[] = [
      // Older complete night → Jun 3 (contiguous).
      row("2026-06-02T23:00:00.000Z", "CORE", 200), // 21:00 → 01:00 Jun 3
      row("2026-06-03T01:00:00.000Z", "DEEP", 120), // 01:00 → 03:00 Jun 3
      // Last night, asleep before local midnight → Jun 4 (contiguous).
      row("2026-06-03T21:00:00.000Z", "CORE", 150), // 20:30 → 23:00 Jun 3
      row("2026-06-03T23:30:00.000Z", "DEEP", 150), // 23:00 → 01:30 Jun 4
      row("2026-06-04T04:00:00.000Z", "REM", 270), //  23:30 → 06:00 Jun 4
    ];
    const { summary, latestNight } = summarizeSleepNights(rows, "Europe/Berlin");
    expect(summary.count).toBe(2);
    expect(latestNight?.night).toBe("2026-06-04");
    // Full last night = 150 + 150 + 270 = 570 (not just a post-midnight slice).
    expect(latestNight?.asleepMinutes).toBe(570);
    expect(summary.latest).toBe(570);
  });
});
