import { describe, it, expect } from "vitest";
import type { MeasurementSource, SleepStage } from "@/generated/prisma/client";
import {
  reconstructSleepNights,
  reconstructSleepSessions,
  pickMainNightAndNaps,
  summarizeSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";

/** Build a stage row with a fixed wall-clock instant. */
function row(
  iso: string,
  stage: SleepStage | null,
  minutes: number,
  source?: MeasurementSource,
): SleepStageRow {
  return {
    measuredAt: new Date(iso),
    sleepStage: stage,
    value: minutes,
    ...(source ? { source } : {}),
  };
}

/** Build a stage row tagged with an ingest source. */
function srcRow(
  iso: string,
  stage: SleepStage | null,
  minutes: number,
  source: MeasurementSource,
): SleepStageRow {
  return {
    measuredAt: new Date(iso),
    sleepStage: stage,
    value: minutes,
    source,
  };
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
    const rows: SleepStageRow[] = [row("2026-06-04T06:00:00.000Z", null, 423)];
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

  it("does NOT double-count a bare ASLEEP aggregate against the granular stages (HIGH, v1.11.5)", () => {
    // Apple Health writes BOTH an unspecified `ASLEEP` AGGREGATE row AND the
    // granular CORE/DEEP/REM breakdown for the SAME night. The granular rows
    // partition the same period the aggregate covers, so summing them would
    // ~double the night (here: 480 granular + 480 bare = 960 ≈ 16 h, the
    // real-data symptom). The asleep total must be the GRANULAR sum (~8 h),
    // never the granular + bare blend.
    const rows: SleepStageRow[] = [
      // Granular breakdown — the canonical partition (8 h total).
      row("2026-06-04T01:00:00.000Z", "CORE", 240), //  23:00 → 03:00
      row("2026-06-04T03:00:00.000Z", "DEEP", 120), //  03:00 → 05:00
      row("2026-06-04T05:00:00.000Z", "REM", 120), //   05:00 → 07:00
      // Unspecified ASLEEP aggregate covering the SAME 8 h — must be dropped.
      row("2026-06-04T05:00:00.000Z", "ASLEEP", 480),
      // IN_BED + AWAKE never count toward asleep.
      row("2026-06-04T05:00:00.000Z", "IN_BED", 510),
      row("2026-06-04T04:30:00.000Z", "AWAKE", 30),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    // Granular only: 240 + 120 + 120 = 480 (8 h), NOT 960 (16 h).
    expect(nights[0].asleepMinutes).toBe(480);
    expect(nights[0].inBedMinutes).toBe(510);
    expect(nights[0].awakeMinutes).toBe(30);
    // HIGH (H1): the per-stage `stages` map must NOT carry the bare ASLEEP
    // aggregate alongside the granular partition — it would render a
    // double-height green ASLEEP segment on top of CORE+DEEP+REM. Only the
    // granular stages + IN_BED + AWAKE survive.
    expect(nights[0].stages.ASLEEP).toBeUndefined();
    expect(nights[0].stages.CORE).toBe(240);
    expect(nights[0].stages.DEEP).toBe(120);
    expect(nights[0].stages.REM).toBe(120);
    expect(nights[0].stages.IN_BED).toBe(510);
    expect(nights[0].stages.AWAKE).toBe(30);
  });

  it("includes a bare-only nap in the night total when the overnight is granular (MEDIUM-1, v1.11.5)", () => {
    // Same wake day: a granular WHOOP overnight (8 h) plus a bare-ASLEEP-only
    // Apple nap (45 min) more than 3 h later. Reconstructing over the MERGED
    // pool would set sawGranular from the overnight and wrongly drop the
    // nap's bare ASLEEP. The per-session asleep total must keep the nap.
    const rows: SleepStageRow[] = [
      // Overnight (WHOOP, granular): 23:00 → 07:00 = 8 h asleep.
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 120, "WHOOP"),
      srcRow("2026-06-04T07:00:00.000Z", "REM", 120, "WHOOP"),
      // Afternoon nap (Apple, bare ASLEEP only): 14:00 → 14:45 = 45 min,
      // well beyond the 3 h session gap from the overnight.
      srcRow("2026-06-04T14:45:00.000Z", "ASLEEP", 45, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    // 480 (granular overnight) + 45 (bare nap) = 525, NOT 480 (nap dropped).
    expect(nights[0].asleepMinutes).toBe(525);
    // The night's stages carry the granular overnight AND the nap's bare
    // ASLEEP — the nap was a separate session with no granular partition, so
    // its bare aggregate is its only asleep signal and survives.
    expect(nights[0].stages.CORE).toBe(240);
    expect(nights[0].stages.DEEP).toBe(120);
    expect(nights[0].stages.REM).toBe(120);
    expect(nights[0].stages.ASLEEP).toBe(45);
  });

  it("falls back to the bare ASLEEP row when no granular stage exists", () => {
    // Legacy iOS 15- writes only the unspecified aggregate — there is no
    // granular partition, so the bare ASLEEP row IS the night's total.
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", "ASLEEP", 465),
      row("2026-06-04T06:00:00.000Z", "IN_BED", 500),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    expect(nights[0].asleepMinutes).toBe(465);
    expect(nights[0].inBedMinutes).toBe(500);
  });

  it("does not double-count bare+granular WITHIN one source on a dual-source night", () => {
    // Both WHOOP and Apple Health report the same night, and EACH writes a
    // bare ASLEEP aggregate alongside its granular breakdown. The night must
    // collapse to ONE source (WHOOP by default ladder) AND count only that
    // source's granular stages — no cross-source sum, no bare double-count.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "ASLEEP", 420, "WHOOP"), // bare WHOOP aggregate
      srcRow("2026-06-04T01:05:00.000Z", "CORE", 230, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:05:00.000Z", "DEEP", 85, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:35:00.000Z", "REM", 80, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:35:00.000Z", "ASLEEP", 395, "APPLE_HEALTH"), // bare Apple aggregate
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    // WHOOP granular only: 240 + 90 + 90 = 420, not 840 (bare+granular) and
    // not the ~1660 four-way blend of both sources' bare + granular rows.
    expect(nights[0].asleepMinutes).toBe(420);
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

  it("prefers the stage-granular source over a coarse one regardless of ladder", () => {
    // Mixed night: WHOOP writes the full hypnogram (REM/CORE/DEEP/AWAKE),
    // Apple Health writes only coarse AWAKE/ASLEEP blocks + IN_BED for the
    // SAME night. Even with a ladder that ranks Apple Health first, the
    // granular WHOOP partition must carry the night — otherwise the chart
    // collapses to awake/asleep and the stages disappear.
    const priorityJson = { sleep: ["APPLE_HEALTH", "WHOOP"] };
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      srcRow("2026-06-04T04:40:00.000Z", "AWAKE", 10, "WHOOP"),
      // Apple Health's coarse parallel export of the same night.
      srcRow("2026-06-04T01:30:00.000Z", "ASLEEP", 110, "APPLE_HEALTH"),
      srcRow("2026-06-04T01:40:00.000Z", "AWAKE", 10, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:30:00.000Z", "ASLEEP", 100, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "ASLEEP", 60, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:40:00.000Z", "IN_BED", 430, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "UTC", priorityJson);
    expect(nights).toHaveLength(1);
    // WHOOP's granular partition: 240 + 90 + 90 = 420.
    expect(nights[0].asleepMinutes).toBe(420);
    expect(nights[0].stages.REM).toBe(90);
    expect(nights[0].stages.DEEP).toBe(90);
    expect(nights[0].stages.CORE).toBe(240);
    // The coarse source's bare ASLEEP blocks must not blend in.
    expect(nights[0].stages.ASLEEP).toBeUndefined();
  });

  it("keeps the coarse source as fallback when no granular source exists", () => {
    const priorityJson = { sleep: ["APPLE_HEALTH", "WHOOP"] };
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:30:00.000Z", "ASLEEP", 110, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:30:00.000Z", "ASLEEP", 100, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "UTC", priorityJson);
    expect(nights).toHaveLength(1);
    expect(nights[0].asleepMinutes).toBe(210);
  });
});

describe("reconstructSleepSessions", () => {
  it("resolves each stage row to start = end − duration", () => {
    const rows: SleepStageRow[] = [
      // 240-min CORE ending 03:00 UTC → starts 23:00 the previous instant.
      row("2026-06-04T03:00:00.000Z", "CORE", 240),
      row("2026-06-04T04:30:00.000Z", "REM", 90), // 03:00 → 04:30
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.start.toISOString()).toBe("2026-06-03T23:00:00.000Z");
    expect(s.end.toISOString()).toBe("2026-06-04T04:30:00.000Z");
    // Segments carry their own start/end span.
    const core = s.segments.find((seg) => seg.stage === "CORE");
    expect(core?.start.toISOString()).toBe("2026-06-03T23:00:00.000Z");
    expect(core?.end.toISOString()).toBe("2026-06-04T03:00:00.000Z");
    expect(s.asleepMinutes).toBe(330);
  });

  it("splits a daytime nap into its own session, separate from the night", () => {
    const rows: SleepStageRow[] = [
      row("2026-06-03T13:00:00.000Z", "CORE", 45), //  14:15 → 15:00 nap
      // Overnight contiguous block.
      row("2026-06-03T21:00:00.000Z", "CORE", 200),
      row("2026-06-03T23:00:00.000Z", "DEEP", 120),
      row("2026-06-04T01:00:00.000Z", "REM", 120),
      row("2026-06-04T04:00:00.000Z", "CORE", 180),
    ];
    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    expect(sessions).toHaveLength(2);
    // Sorted ascending by start: nap first, overnight second.
    expect(sessions[0].asleepMinutes).toBe(45);
    expect(sessions[1].asleepMinutes).toBe(620);
  });

  it("keeps only the canonical source's segments on a dual-source night", () => {
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      srcRow("2026-06-04T01:05:00.000Z", "CORE", 230, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:05:00.000Z", "DEEP", 85, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("WHOOP");
    // Only WHOOP's 3 segments survive; Apple Health's are dropped.
    expect(sessions[0].segments).toHaveLength(3);
    expect(sessions[0].asleepMinutes).toBe(420);
  });

  it("flags a WHOOP-won night as reconstructed (synthetic stage order) with clock-time-distinct segments", () => {
    // The ingest mapper reconstructs an ordered, contiguous WHOOP timeline.
    // The reconstructed segments carry distinct measuredAt instants, so the
    // hypnogram lays them at distinct clock times (no shared right edge).
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"), // 21:00→01:00
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 120, "WHOOP"), // 01:00→03:00
      srcRow("2026-06-04T05:00:00.000Z", "REM", 120, "WHOOP"), //  03:00→05:00
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.source).toBe("WHOOP");
    expect(s.reconstructed).toBe(true);
    // No two segments end on the same instant — not stacked on the right edge.
    const ends = s.segments.map((seg) => seg.end.getTime());
    expect(new Set(ends).size).toBe(ends.length);
  });

  it("does NOT flag an Apple-Health night as reconstructed (measured timeline)", () => {
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("APPLE_HEALTH");
    expect(sessions[0].reconstructed).toBe(false);
  });

  it("does NOT flag a Withings night as reconstructed (real per-segment series)", () => {
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WITHINGS"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 90, "WITHINGS"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("WITHINGS");
    expect(sessions[0].reconstructed).toBe(false);
  });

  it("drops the bare ASLEEP aggregate from segments + stages when granular exists (HIGH H1, v1.11.5)", () => {
    // Apple-Health shape: granular CORE/DEEP/REM PLUS the unspecified ASLEEP
    // aggregate covering the same period, plus IN_BED. The hypnogram must not
    // draw a double-height ASLEEP lane on top of the granular stages, so the
    // bare ASLEEP segment is dropped and `stages.ASLEEP` is absent.
    const rows: SleepStageRow[] = [
      row("2026-06-04T01:00:00.000Z", "CORE", 240),
      row("2026-06-04T03:00:00.000Z", "DEEP", 120),
      row("2026-06-04T05:00:00.000Z", "REM", 120),
      row("2026-06-04T05:00:00.000Z", "ASLEEP", 480), // redundant aggregate
      row("2026-06-04T05:00:00.000Z", "IN_BED", 510),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    // No ASLEEP segment survives; CORE + DEEP + REM + IN_BED do (4 segments).
    expect(s.segments.some((seg) => seg.stage === "ASLEEP")).toBe(false);
    expect(s.segments).toHaveLength(4);
    expect(s.stages.ASLEEP).toBeUndefined();
    expect(s.asleepMinutes).toBe(480); // granular sum, not 960
    expect(s.inBedMinutes).toBe(510);
  });

  it("prefers a per-segment timeline writer over a summary-shaped writer (v1.16.11)", () => {
    // WHOOP's real wire shape: the v2 API exposes only stage_summary, so
    // every stage row of a night lands with ONE shared measuredAt — the
    // sleep END instant. Reconstructing those as segments yields five
    // spans all touching the right edge of the night. When Apple Health
    // carries genuinely timed per-segment rows for the same night, the
    // timed writer must win even though WHOOP ties (or wins) on distinct
    // stage count and outranks Apple on the default ladder.
    const end = "2026-06-04T05:00:00.000Z";
    const rows: SleepStageRow[] = [
      // WHOOP: full-house stage summary, all stamped on the sleep end.
      srcRow(end, "IN_BED", 510, "WHOOP"),
      srcRow(end, "AWAKE", 30, "WHOOP"),
      srcRow(end, "CORE", 240, "WHOOP"),
      srcRow(end, "DEEP", 120, "WHOOP"),
      srcRow(end, "REM", 120, "WHOOP"),
      // Apple Health: a partial but genuinely timed timeline (2 stages).
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "APPLE_HEALTH"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 120, "APPLE_HEALTH"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("APPLE_HEALTH");
    // The surviving segments carry a real timeline: more than one
    // distinct end instant.
    const ends = new Set(
      sessions[0].segments.map((seg) => seg.end.getTime()),
    );
    expect(ends.size).toBeGreaterThan(1);
  });

  it("keeps a summary-shaped writer when nobody else covers the night (v1.16.11)", () => {
    // WHOOP-only night — the stage summary is all there is, so it must
    // still resolve (the timeline gate is conditional, not absolute).
    const end = "2026-06-04T05:00:00.000Z";
    const rows: SleepStageRow[] = [
      srcRow(end, "CORE", 240, "WHOOP"),
      srcRow(end, "DEEP", 120, "WHOOP"),
      srcRow(end, "REM", 120, "WHOOP"),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("WHOOP");
    expect(sessions[0].asleepMinutes).toBe(480);
  });

  it("keeps the bare ASLEEP segment when NO granular stage exists", () => {
    // Legacy ASLEEP-only night — the bare aggregate IS the timeline, so it
    // must survive as a segment (otherwise the hypnogram would have nothing).
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", "ASLEEP", 450),
      row("2026-06-04T06:00:00.000Z", "IN_BED", 480),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].segments.some((seg) => seg.stage === "ASLEEP")).toBe(
      true,
    );
    expect(sessions[0].stages.ASLEEP).toBe(450);
    expect(sessions[0].asleepMinutes).toBe(450);
  });

  it("counts only MID-sleep AWAKE bouts as awakenings", () => {
    const rows: SleepStageRow[] = [
      // Leading AWAKE before sleep onset — NOT an awakening.
      row("2026-06-04T00:10:00.000Z", "AWAKE", 10),
      row("2026-06-04T02:00:00.000Z", "CORE", 110),
      // Mid-sleep AWAKE bout — counts.
      row("2026-06-04T02:15:00.000Z", "AWAKE", 15),
      row("2026-06-04T04:00:00.000Z", "DEEP", 105),
      // Another mid-sleep AWAKE bout — counts.
      row("2026-06-04T04:10:00.000Z", "AWAKE", 10),
      row("2026-06-04T06:00:00.000Z", "REM", 110),
      // Trailing AWAKE after final wake — NOT an awakening.
      row("2026-06-04T06:05:00.000Z", "AWAKE", 5),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].awakenings).toBe(2);
  });

  it("returns no sessions for empty input", () => {
    expect(reconstructSleepSessions([], "UTC")).toEqual([]);
  });
});

describe("pickMainNightAndNaps", () => {
  it("picks the longest-asleep session as the main night, rest as naps", () => {
    // Same wake day (Berlin): a short nap + the overnight block.
    const rows: SleepStageRow[] = [
      row("2026-06-04T11:00:00.000Z", "CORE", 40), // 12:00 → 12:40 nap (Jun 4)
      // Overnight ~22:00 Jun 3 → 06:00 Jun 4.
      row("2026-06-03T21:00:00.000Z", "CORE", 180),
      row("2026-06-04T00:00:00.000Z", "DEEP", 120),
      row("2026-06-04T04:00:00.000Z", "REM", 180),
    ];
    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    const { main, naps } = pickMainNightAndNaps(sessions);
    expect(main?.asleepMinutes).toBe(480);
    expect(naps).toHaveLength(1);
    expect(naps[0].asleepMinutes).toBe(40);
    // Nap shares the main night's wake day.
    expect(naps[0].night).toBe(main?.night);
  });

  it("returns no main when every session is IN_BED/AWAKE only", () => {
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", "IN_BED", 60),
      row("2026-06-04T06:00:00.000Z", "AWAKE", 60),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    const { main, naps } = pickMainNightAndNaps(sessions);
    expect(main).toBeNull();
    expect(naps).toEqual([]);
  });

  it("does not surface a different wake day's session as a nap", () => {
    // Two overnight blocks on consecutive wake days — neither is the
    // other's nap even though both land in the same input array.
    const rows: SleepStageRow[] = [
      // Wake day Jun 3.
      row("2026-06-03T01:00:00.000Z", "CORE", 240),
      row("2026-06-03T05:00:00.000Z", "DEEP", 120),
      // Wake day Jun 4.
      row("2026-06-04T01:00:00.000Z", "CORE", 300),
      row("2026-06-04T05:00:00.000Z", "DEEP", 120),
    ];
    const sessions = reconstructSleepSessions(rows, "UTC");
    const { main, naps } = pickMainNightAndNaps(sessions);
    // Jun 4 is the longer night.
    expect(main?.night).toBe("2026-06-04");
    expect(naps).toEqual([]);
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

  it("averages ~8 h, not ~16 h, when every night carries bare+granular rows (HIGH, v1.11.5)", () => {
    // Several consecutive nights, each written the real-data way: a bare
    // ASLEEP aggregate PLUS the granular CORE/DEEP/REM partition for the same
    // period. The 30-day-style average must reflect the granular ~8 h totals,
    // not the ~16 h bare+granular blend that produced the live 16.4 h symptom.
    const nightsInput: Array<[string, number, number, number]> = [
      // [wake-day, core, deep, rem] — each sums to 480 min = 8 h.
      ["2026-06-01", 240, 120, 120],
      ["2026-06-02", 250, 110, 120],
      ["2026-06-03", 230, 130, 120],
      ["2026-06-04", 240, 120, 120],
    ];
    const rows: SleepStageRow[] = [];
    for (const [day, core, deep, rem] of nightsInput) {
      // Each night's stages land between 01:00 and 06:00 UTC on the wake day.
      rows.push(row(`${day}T02:00:00.000Z`, "CORE", core));
      rows.push(row(`${day}T04:00:00.000Z`, "DEEP", deep));
      rows.push(row(`${day}T06:00:00.000Z`, "REM", rem));
      // The overlapping bare ASLEEP aggregate (= core+deep+rem) — must drop.
      rows.push(row(`${day}T06:00:00.000Z`, "ASLEEP", core + deep + rem));
    }
    const { summary } = summarizeSleepNights(rows, "UTC");
    expect(summary.count).toBe(4);
    // Mean of 480 / 480 / 480 / 480 = 480 min = 8 h, NOT 960 min = 16 h.
    expect(summary.mean).toBe(480);
    expect((summary.mean ?? 0) / 60).toBe(8);
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
    const { summary, latestNight } = summarizeSleepNights(
      rows,
      "Europe/Berlin",
    );
    expect(summary.count).toBe(2);
    expect(latestNight?.night).toBe("2026-06-04");
    // Full last night = 150 + 150 + 270 = 570 (not just a post-midnight slice).
    expect(latestNight?.asleepMinutes).toBe(570);
    expect(summary.latest).toBe(570);
  });
});

// A4 — the Insights sleep AVERAGE must come from the deduped per-night totals,
// never the raw per-stage sum that double-counts a bare ASLEEP aggregate against
// its granular twin (and folds IN_BED / AWAKE in on top). The ~20.3 h symptom is
// what a single night's stage rows summed without dedup produces.
describe("sleep average dedup (A4)", () => {
  it("one source emits BOTH bare ASLEEP + granular for the same span → dedup total, not the sum", () => {
    // Apple-Health-style double write for ONE overnight session: the bare
    // ASLEEP aggregate (480) PLUS the granular CORE/DEEP/REM partition (also
    // 480), plus IN_BED + AWAKE. Summed raw this is ~1490 min (~24.8 h); the
    // deduped night total is the granular 480 min (8 h).
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", "ASLEEP", 480, "APPLE_HEALTH"), // bare aggregate
      row("2026-06-04T02:00:00.000Z", "CORE", 240, "APPLE_HEALTH"),
      row("2026-06-04T04:00:00.000Z", "DEEP", 120, "APPLE_HEALTH"),
      row("2026-06-04T06:00:00.000Z", "REM", 120, "APPLE_HEALTH"),
      row("2026-06-04T06:30:00.000Z", "IN_BED", 470, "APPLE_HEALTH"),
      row("2026-06-04T03:00:00.000Z", "AWAKE", 20, "APPLE_HEALTH"),
    ];
    const { summary } = summarizeSleepNights(rows, "UTC");
    // Granular partition wins: 240 + 120 + 120 = 480 min — NOT 480 + 480 + …
    expect(summary.latest).toBe(480);
    expect(summary.max).toBe(480);
    // One night, not 6 stage rows.
    expect(summary.count).toBe(1);
  });

  it("multi-source bare+granular collapses to the canonical source, no cross-source sum", () => {
    // WHOOP granular + Apple bare-only for the SAME night. The canonical source
    // (WHOOP, top of the sleep ladder) wins; the night total is WHOOP's dedup
    // total, never WHOOP + Apple summed.
    const rows: SleepStageRow[] = [
      // WHOOP granular — 240 + 120 + 120 = 480.
      row("2026-06-04T02:00:00.000Z", "CORE", 240, "WHOOP"),
      row("2026-06-04T04:00:00.000Z", "DEEP", 120, "WHOOP"),
      row("2026-06-04T06:00:00.000Z", "REM", 120, "WHOOP"),
      // Apple bare aggregate for the same span — must NOT add on top.
      row("2026-06-04T06:00:00.000Z", "ASLEEP", 470, "APPLE_HEALTH"),
    ];
    const { summary } = summarizeSleepNights(rows, "UTC");
    expect(summary.count).toBe(1);
    expect(summary.latest).toBe(480); // WHOOP only, not 480 + 470.
  });
});

// A5 — `reconstructSleepSessions` must never throw on a session the dedup
// empties (the unguarded `segments[0]` access). A read returns a valid empty
// night, never a 500.
describe("reconstructSleepSessions total-safety (A5)", () => {
  it("never throws on an IN_BED/AWAKE-only session and yields no main night", () => {
    const rows: SleepStageRow[] = [
      row("2026-06-04T06:00:00.000Z", "IN_BED", 60),
      row("2026-06-04T06:00:00.000Z", "AWAKE", 60),
    ];
    expect(() => reconstructSleepSessions(rows, "UTC")).not.toThrow();
    const sessions = reconstructSleepSessions(rows, "UTC");
    // Every returned session has at least one renderable segment.
    expect(sessions.every((s) => s.segments.length > 0)).toBe(true);
    expect(pickMainNightAndNaps(sessions).main).toBeNull();
  });

  it("skips a session that empties after the granular-over-bare filter, never throws", () => {
    // A session whose canonical pool, after dropping the redundant bare ASLEEP
    // aggregate / stage-less twins under `sawGranular`, has zero renderable
    // segments. The DEEP granular row marks the session granular; the bare +
    // stage-less rows are then filtered out. The granular row survives here, so
    // assert the load-bearing contract: no throw, and every returned session is
    // non-empty.
    const rows: SleepStageRow[] = [
      row("2026-06-04T02:00:00.000Z", "DEEP", 1), // tiny granular marker
      row("2026-06-04T06:00:00.000Z", "ASLEEP", 480), // redundant bare twin
      row("2026-06-04T06:00:00.000Z", null, 480), // stage-less twin
    ];
    expect(() => reconstructSleepSessions(rows, "UTC")).not.toThrow();
    const sessions = reconstructSleepSessions(rows, "UTC");
    expect(sessions.every((s) => s.segments.length > 0)).toBe(true);
  });

  it("never throws on a stage-less-only session", () => {
    // Legacy / manual stage-less rows only — no granular partition, so they are
    // the fallback signal and survive the filter; still must not throw.
    const rows: SleepStageRow[] = [row("2026-06-04T06:00:00.000Z", null, 480)];
    expect(() => reconstructSleepSessions(rows, "UTC")).not.toThrow();
  });
});

/** Build a stage row tagged with a source AND a writer device-type. */
function writerRow(
  iso: string,
  stage: SleepStage | null,
  minutes: number,
  source: MeasurementSource,
  deviceType: string | null,
): SleepStageRow {
  return {
    measuredAt: new Date(iso),
    sleepStage: stage,
    value: minutes,
    source,
    deviceType,
  };
}

describe("per-night writer richness pick", () => {
  it("a coarse awake-heavy source never masks the source that knows the stages", () => {
    // The reported night: one source contributes a huge AWAKE block plus a
    // sliver of bare ASLEEP (a phone/in-bed detection mis-scoring the night),
    // the other carries the full hypnogram. The stage-bearing source must
    // win the night — the headline is NOT 400 awake minutes with no phases.
    const rows: SleepStageRow[] = [
      // Coarse export: 22:50 → 06:35 local, awake-dominant.
      srcRow("2026-06-04T01:00:00.000Z", "IN_BED", 250, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "AWAKE", 400, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:35:00.000Z", "ASLEEP", 30, "APPLE_HEALTH"),
      // Detailed stages for the SAME night.
      srcRow("2026-06-04T01:30:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 80, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "AWAKE", 35, "WHOOP"),
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    expect(nights[0].stages.CORE).toBe(240);
    expect(nights[0].stages.DEEP).toBe(80);
    expect(nights[0].stages.REM).toBe(90);
    // The winner's own awake minutes survive; the coarse 400 must not.
    expect(nights[0].awakeMinutes).toBe(35);
    expect(nights[0].asleepMinutes).toBe(410);
    // The losing writer's IN_BED envelope survives — "Zeit im Bett" is a
    // union across writers, never erased by the stage-richness pick.
    expect(nights[0].inBedMinutes).toBe(250);

    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("WHOOP");
    expect(sessions[0].stages.AWAKE).toBe(35);
    expect(sessions[0].inBedMinutes).toBe(250);
  });

  it("separates writer apps behind ONE source: phone in-bed must not blend into watch stages", () => {
    // Several HealthKit apps write under source = APPLE_HEALTH. The watch
    // carries the granular partition; the phone's bedtime detection writes a
    // parallel IN_BED + a long AWAKE block. Collapsing per source would blend
    // both writers and inflate the night's awake total — the device-type
    // refinement must keep only the stage-bearing writer.
    const rows: SleepStageRow[] = [
      writerRow(
        "2026-06-04T00:30:00.000Z",
        "CORE",
        120,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T02:30:00.000Z",
        "DEEP",
        60,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow("2026-06-04T04:00:00.000Z", "REM", 80, "APPLE_HEALTH", "watch"),
      writerRow(
        "2026-06-04T04:30:00.000Z",
        "AWAKE",
        15,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T04:30:00.000Z",
        "IN_BED",
        460,
        "APPLE_HEALTH",
        "phone",
      ),
      writerRow(
        "2026-06-04T00:35:00.000Z",
        "ASLEEP",
        200,
        "APPLE_HEALTH",
        "phone",
      ),
      writerRow(
        "2026-06-04T03:00:00.000Z",
        "AWAKE",
        385,
        "APPLE_HEALTH",
        "phone",
      ),
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    expect(nights[0].stages.CORE).toBe(120);
    expect(nights[0].stages.DEEP).toBe(60);
    expect(nights[0].stages.REM).toBe(80);
    // The watch writer's awake sliver, not the phone's 385-minute block.
    expect(nights[0].awakeMinutes).toBe(15);
    // The phone's bare ASLEEP must not blend into the asleep total either.
    expect(nights[0].asleepMinutes).toBe(260);
    // The night keeps the stages AND a sane in-bed figure: the watch wins
    // the stage views, but "Zeit im Bett" is the union envelope across
    // writers — the phone's 460-minute IN_BED window must not shrink to
    // null just because the watch carried no IN_BED row.
    expect(nights[0].inBedMinutes).toBe(460);

    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    expect(sessions).toHaveLength(1);
    // The session's hypnogram segments stay winner-only (no phone lanes)…
    expect(sessions[0].segments.some((seg) => seg.stage === "IN_BED")).toBe(
      false,
    );
    // …while the session-level in-bed figure keeps the phone's envelope.
    expect(sessions[0].inBedMinutes).toBe(460);
  });

  it("merges overlapping IN_BED spans from two writers without double-counting", () => {
    // Watch and phone both export an IN_BED window for the same night;
    // the spans overlap by four hours. The union envelope is 22:00 →
    // 06:00 (480 min), never the 360 + 360 = 720 sum.
    const rows: SleepStageRow[] = [
      writerRow(
        "2026-06-04T02:00:00.000Z",
        "CORE",
        200,
        "APPLE_HEALTH",
        "watch",
      ),
      // Watch IN_BED 22:00 → 04:00 UTC.
      writerRow(
        "2026-06-04T04:00:00.000Z",
        "IN_BED",
        360,
        "APPLE_HEALTH",
        "watch",
      ),
      // Phone IN_BED 00:00 → 06:00 UTC — overlaps the watch span.
      writerRow(
        "2026-06-04T06:00:00.000Z",
        "IN_BED",
        360,
        "APPLE_HEALTH",
        "phone",
      ),
    ];
    const nights = reconstructSleepNights(rows, "UTC");
    expect(nights).toHaveLength(1);
    expect(nights[0].inBedMinutes).toBe(480);
  });

  it("rows without a device-type collapse per source exactly as before", () => {
    // Legacy rows (pre device-type column) and single-writer sources: one
    // bucket per source — granular + in-bed from the same source stay one
    // night with both facets.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T00:30:00.000Z", "CORE", 120, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "AWAKE", 15, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "IN_BED", 460, "APPLE_HEALTH"),
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    expect(nights[0].stages.CORE).toBe(120);
    expect(nights[0].inBedMinutes).toBe(460);
    expect(nights[0].awakeMinutes).toBe(15);
  });

  it("the RICHEST stage set wins: three granular stages beat one, regardless of ladder", () => {
    // WHOOP sits first on the default ladder but only knows CORE for this
    // night; the watch carries the full three-stage hypnogram. Per-night
    // richness must pick the watch.
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T04:30:00.000Z", "CORE", 300, "WHOOP"),
      writerRow(
        "2026-06-04T00:30:00.000Z",
        "CORE",
        120,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T02:30:00.000Z",
        "DEEP",
        60,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow("2026-06-04T04:00:00.000Z", "REM", 80, "APPLE_HEALTH", "watch"),
    ];
    const nights = reconstructSleepNights(rows, "Europe/Berlin");
    expect(nights).toHaveLength(1);
    expect(nights[0].stages.REM).toBe(80);
    expect(nights[0].stages.DEEP).toBe(60);
    expect(nights[0].stages.CORE).toBe(120);
    expect(nights[0].asleepMinutes).toBe(260);
  });

  it("equally rich writers fall back to the ladder (WHOOP beats Apple Health)", () => {
    const rows: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 80, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
      writerRow(
        "2026-06-04T00:30:00.000Z",
        "CORE",
        120,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow(
        "2026-06-04T02:30:00.000Z",
        "DEEP",
        60,
        "APPLE_HEALTH",
        "watch",
      ),
      writerRow("2026-06-04T04:00:00.000Z", "REM", 80, "APPLE_HEALTH", "watch"),
    ];
    const sessions = reconstructSleepSessions(rows, "Europe/Berlin");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source).toBe("WHOOP");
    expect(sessions[0].asleepMinutes).toBe(410);
  });

  it("a coarse-only night heals on the next read once the stage rows land", () => {
    // The reconstruction is read-time: a night first assembled from coarse
    // rows (detailed sync lagging) must flip to the stage partition as soon
    // as the detailed rows exist — no manual repair, no cache to clear.
    const coarseOnly: SleepStageRow[] = [
      srcRow("2026-06-04T01:00:00.000Z", "IN_BED", 250, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:30:00.000Z", "AWAKE", 400, "APPLE_HEALTH"),
      srcRow("2026-06-04T04:35:00.000Z", "ASLEEP", 30, "APPLE_HEALTH"),
    ];
    const before = reconstructSleepNights(coarseOnly, "Europe/Berlin");
    expect(before[0].stages.REM).toBeUndefined();
    expect(before[0].awakeMinutes).toBe(400);

    const afterRows: SleepStageRow[] = [
      ...coarseOnly,
      srcRow("2026-06-04T01:30:00.000Z", "CORE", 240, "WHOOP"),
      srcRow("2026-06-04T03:00:00.000Z", "DEEP", 80, "WHOOP"),
      srcRow("2026-06-04T04:30:00.000Z", "REM", 90, "WHOOP"),
    ];
    const after = reconstructSleepNights(afterRows, "Europe/Berlin");
    expect(after).toHaveLength(1);
    expect(after[0].stages.REM).toBe(90);
    expect(after[0].stages.DEEP).toBe(80);
    expect(after[0].stages.CORE).toBe(240);
    expect(after[0].awakeMinutes).toBeNull();
    expect(after[0].asleepMinutes).toBe(410);
  });
});
