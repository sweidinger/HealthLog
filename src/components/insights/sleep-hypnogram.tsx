"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations, useTimeFormatPreference } from "@/lib/i18n/context";
import { hourCycleOptions } from "@/lib/format-locale";
import { STAGE_COLORS } from "./sleep-stage-stacked-bar";

/**
 * v1.11.5 — last-night HYPNOGRAM (the maintainer directive: the phase-progression
 * view). Renders one night's stage timeline as a stepped depth track —
 * Awake at the top, Deep at the base — over clock time, in the Dracula
 * stage palette reused from `sleep-stage-stacked-bar.tsx` (no token
 * reshuffle, per the charts-visual-identity rule). Below the chart: the
 * per-stage breakdown (time + %), total asleep, time in bed, and the
 * mid-sleep awakenings count.
 *
 * One canonical source per night (the endpoint already collapsed it), so
 * exactly one timeline renders — Apple ↔ WHOOP are never overlaid.
 *
 * Recharts stays (project rule). Each stage segment is drawn as its own
 * `ReferenceArea` rectangle spanning the segment's [start, end] clock range
 * at the stage's depth lane, filled with the segment's `STAGE_COLORS` token
 * (the same palette the breakdown legend below uses) — so the chart reads as
 * a coloured "cityscape" rather than one flat single-colour line. Depth still
 * increases downward (Awake top, Deep base).
 *
 * v1.11.5 — the chart renders only when per-segment `segments` exist
 * (`hasTrack`); the per-stage breakdown + totals footer render whenever
 * `session.stages` carries any positive value, so a legacy stage-summary
 * night (no segment spans) still shows its breakdown instead of collapsing
 * the whole card to "unavailable".
 */

export interface SleepHypnogramSegment {
  stage: string | null;
  start: string;
  end: string;
  minutes: number;
}

export interface SleepHypnogramSession {
  night: string;
  source: string | null;
  start: string;
  end: string;
  asleepMinutes: number;
  inBedMinutes: number | null;
  awakeMinutes: number | null;
  awakenings: number;
  stages: Record<string, number>;
  segments: SleepHypnogramSegment[];
  /**
   * `true` when the winning source has no measured per-stage onset
   * timestamps and the server synthesised a contiguous timeline in a fixed
   * physiological order (WHOOP / Polar). The "timeline" of such a night is
   * not a real hypnogram — it would read as one long Core block followed by
   * one Deep block, never the phase-to-phase progression a measured night
   * shows — so we never draw the misleading stepped bar for it and fall back
   * to the per-stage breakdown alone. A real-series source (Apple Health,
   * Withings, Fitbit) is `false` and keeps the timeline.
   */
  reconstructed?: boolean;
}

export interface SleepHypnogramProps {
  session: SleepHypnogramSession;
}

/**
 * Lane order top → bottom. Awake highest, Deep lowest — depth increases
 * downward, matching Apple Health / Oura's "cityscape" convention. Only
 * the stages actually present in the night's spans get a lane (the
 * order is preserved) — painting all six lanes left an Apple night
 * (AWAKE/REM/CORE/DEEP) with two permanently empty rows.
 */
const LANE_ORDER = [
  "AWAKE",
  "IN_BED",
  "ASLEEP",
  "REM",
  "CORE",
  "DEEP",
] as const;

/** Breakdown order — deepest restorative first, matching the stacked bar. */
const BREAKDOWN_ORDER = [
  "DEEP",
  "REM",
  "CORE",
  "ASLEEP",
  "AWAKE",
  "IN_BED",
] as const;

function formatMinutes(total: number, locale: string): string {
  const hours = Math.floor(total / 60);
  const mins = Math.round(total - hours * 60);
  if (locale === "de") {
    return hours > 0 ? `${hours} Std. ${mins} Min.` : `${mins} Min.`;
  }
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

export function SleepHypnogram({ session }: SleepHypnogramProps) {
  const { t, locale } = useTranslations();
  const timeFormat = useTimeFormatPreference();

  const stageLabels: Record<string, string> = {
    DEEP: t("insights.sleep.stages.deep"),
    REM: t("insights.sleep.stages.rem"),
    CORE: t("insights.sleep.stages.core"),
    ASLEEP: t("insights.sleep.stages.asleep"),
    AWAKE: t("insights.sleep.stages.awake"),
    IN_BED: t("insights.sleep.stages.inBed"),
  };

  // Build one coloured span per stage segment: its [start, end] clock range
  // at the stage's depth lane, in the stage's own palette token. Each span
  // renders as a `ReferenceArea` so the chart is multi-coloured (a single
  // Recharts line can only carry one stroke). Lanes derive from the stages
  // PRESENT in the spans (in `LANE_ORDER` order) so a four-stage night
  // paints four lanes, not six.
  const { spans, lanes } = useMemo(() => {
    const known = new Set<string>(LANE_ORDER);
    const segments = [...session.segments]
      .filter((seg) => seg.stage != null && known.has(seg.stage))
      .sort(
        (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
      );
    const present = new Set(segments.map((seg) => seg.stage as string));
    const lanes = LANE_ORDER.filter((stage) => present.has(stage));
    const laneOf: Record<string, number> = Object.fromEntries(
      // Reverse-index so the first present stage sits at the highest y.
      lanes.map((s, i) => [s, lanes.length - 1 - i]),
    );
    const spans = segments.map((seg) => {
      const stage = seg.stage as string;
      return {
        stage,
        x1: new Date(seg.start).getTime(),
        x2: new Date(seg.end).getTime(),
        lane: laneOf[stage],
        fill: STAGE_COLORS[stage],
      };
    });
    return { spans, lanes };
  }, [session.segments]);

  const domain = useMemo<[number, number]>(
    () => [new Date(session.start).getTime(), new Date(session.end).getTime()],
    [session.start, session.end],
  );

  // v1.12.0 — explicit clock-aligned X-axis ticks. With `data={[]}` Recharts
  // has no points to derive ticks from and would otherwise label the domain
  // endpoints with raw bedtime/wake stamps (e.g. 23:14 / 06:02). Snap to whole
  // clock hours and pick a 1–3 h step from the night's span so the axis reads
  // 23:00 / 01:00 / 03:00 / 05:00 and stays mobile-legible (≈4–6 ticks).
  const xTicks = useMemo(() => {
    const [from, to] = domain;
    const spanHours = (to - from) / 3_600_000;
    if (!Number.isFinite(spanHours) || spanHours <= 0) return [];
    // Aim for ~5 ticks: 1 h up to 5 h span, 2 h up to 10 h, else 3 h.
    const stepHours = spanHours <= 5 ? 1 : spanHours <= 10 ? 2 : 3;
    const stepMs = stepHours * 3_600_000;
    // First whole hour at or after `from`, aligned to the step grid.
    const firstHour = new Date(from);
    firstHour.setMinutes(0, 0, 0);
    if (firstHour.getTime() < from)
      firstHour.setTime(firstHour.getTime() + 3_600_000);
    // Align the first tick to a multiple of the step (relative to midnight).
    while (firstHour.getHours() % stepHours !== 0) {
      firstHour.setTime(firstHour.getTime() + 3_600_000);
    }
    const ticks: number[] = [];
    for (let t = firstHour.getTime(); t <= to; t += stepMs) {
      ticks.push(t);
    }
    return ticks;
  }, [domain]);

  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
        hour: "2-digit",
        minute: "2-digit",
        ...hourCycleOptions(timeFormat),
      }),
    [locale, timeFormat],
  );

  // Per-stage breakdown with percentage of the night's total tracked time.
  const breakdown = useMemo(() => {
    const total = Object.values(session.stages).reduce((s, v) => s + v, 0);
    return BREAKDOWN_ORDER.filter(
      (stage) => (session.stages[stage] ?? 0) > 0,
    ).map((stage) => {
      const mins = session.stages[stage] ?? 0;
      return {
        stage,
        minutes: mins,
        pct: total > 0 ? Math.round((mins / total) * 100) : 0,
      };
    });
  }, [session.stages]);

  const ariaLabel = t("insights.sleep.hypnogram.ariaLabel", {
    asleep: formatMinutes(session.asleepMinutes, locale),
    awakenings: String(session.awakenings),
  });

  // The CHART needs per-segment spans; the BREAKDOWN + totals footer only
  // need any positive per-stage minutes. A legacy stage-summary night (no
  // segment spans) still shows its breakdown rather than collapsing the
  // whole card. "Unavailable" is reserved for a truly empty session.
  // Spans must also carry more than one distinct START instant: a real
  // night with timed stages steps through the clock, so its segments begin
  // at different instants and earn the timeline bar. Only a degenerate
  // session whose every segment starts on a single instant collapses to the
  // breakdown footer. (Gating on the END instant instead hid the bar for an
  // ordinary multi-stage night whose segments happened to share a right
  // edge — the regression this restores.)
  // A SYNTHESISED night (WHOOP / Polar) has no measured stage onsets — the
  // server laid its segments out in a fixed physiological order, so drawing
  // the stepped bar would invent a phase progression that was never recorded
  // (the "Core block then Deep block, no real breakdown" the bar reads as).
  // For those we keep the per-stage breakdown + totals, which ARE real, and
  // drop the misleading timeline entirely. Real-series sources keep the bar.
  const hasTrack =
    session.reconstructed !== true &&
    spans.length > 0 &&
    (spans.length === 1 || new Set(spans.map((s) => s.x1)).size > 1);
  const hasBreakdown = breakdown.length > 0;

  return (
    // v1.12.0 — card tightened: drop the default Card `gap-4 md:gap-6` to
    // `gap-3` so the header sits closer to the timeline, reclaiming the empty
    // band the maintainer flagged. The chart keeps its 200 px footprint.
    <Card data-slot="sleep-hypnogram" className="gap-3 md:gap-3">
      <CardHeader className="pb-0">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="text-base font-semibold">
            {t("insights.sleep.hypnogram.title")}
          </CardTitle>
          <span className="text-muted-foreground text-xs">
            {t("insights.sleep.hypnogram.subtitle", {
              asleep: formatMinutes(session.asleepMinutes, locale),
            })}
          </span>
          {/* The night's measuring source rides the header as a muted
              caption — it is already on the wire, and "which device
              tracked this" is the first question a multi-tracker user
              asks about a surprising night. */}
          {session.source ? (
            <span
              data-slot="sleep-hypnogram-source"
              className="text-muted-foreground text-xs"
            >
              {t("insights.sleep.hypnogram.source", {
                source: session.source,
              })}
            </span>
          ) : null}
          {/* When the source reports stage TOTALS but no measured onsets
              (WHOOP / Polar) the stepped timeline is suppressed — drawing one
              would invent a phase order that was never recorded. Surface a calm
              note so the breakdown below doesn't read as a missing chart. */}
          {session.reconstructed === true && hasBreakdown ? (
            <span
              data-slot="sleep-hypnogram-estimate-note"
              className="text-muted-foreground text-xs"
            >
              {t("insights.sleep.hypnogram.estimateNote")}
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasTrack && !hasBreakdown ? (
          <p
            className="text-muted-foreground py-8 text-center text-xs"
            data-slot="sleep-hypnogram-empty"
          >
            {t("insights.sleep.stages.unavailable")}
          </p>
        ) : (
          <>
            {hasTrack && (
              <div role="img" aria-label={ariaLabel}>
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart
                    data={[]}
                    margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--border)"
                      opacity={0.3}
                    />
                    <XAxis
                      type="number"
                      dataKey="t"
                      domain={domain}
                      scale="time"
                      ticks={xTicks}
                      stroke="var(--muted-foreground)"
                      fontSize={10}
                      tickFormatter={(v: number) => timeFmt.format(new Date(v))}
                    />
                    <YAxis
                      type="number"
                      dataKey="lane"
                      domain={[-0.5, lanes.length - 0.5]}
                      ticks={lanes.map((_, i) => lanes.length - 1 - i)}
                      stroke="var(--muted-foreground)"
                      fontSize={10}
                      width={56}
                      tickFormatter={(v: number) => {
                        const stage = lanes[lanes.length - 1 - v];
                        return stage ? (stageLabels[stage] ?? "") : "";
                      }}
                    />
                    {spans.map((span, i) => (
                      <ReferenceArea
                        key={`${span.stage}-${i}`}
                        x1={span.x1}
                        x2={span.x2}
                        y1={span.lane - 0.4}
                        y2={span.lane + 0.4}
                        fill={span.fill}
                        fillOpacity={0.9}
                        stroke="none"
                        ifOverflow="extendDomain"
                      />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            {hasBreakdown && (
              <>
                <div
                  className="space-y-1.5"
                  data-slot="sleep-hypnogram-breakdown"
                >
                  {breakdown.map(({ stage, minutes, pct }) => (
                    <div
                      key={stage}
                      className="flex items-center justify-between gap-3 text-xs"
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className="inline-block h-2 w-2 rounded-sm"
                          style={{ background: STAGE_COLORS[stage] }}
                        />
                        {stageLabels[stage] ?? stage}
                      </span>
                      <span className="text-muted-foreground tabular-nums">
                        {formatMinutes(minutes, locale)} · {pct}%
                      </span>
                    </div>
                  ))}
                </div>

                <div className="border-border flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-xs">
                  <span className="font-medium">
                    {t("insights.sleep.hypnogram.asleepTotal", {
                      value: formatMinutes(session.asleepMinutes, locale),
                    })}
                  </span>
                  {session.inBedMinutes != null && (
                    <span className="text-muted-foreground">
                      {t("insights.sleep.hypnogram.inBedTotal", {
                        value: formatMinutes(session.inBedMinutes, locale),
                      })}
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    {t("insights.sleep.hypnogram.awakenings", {
                      count: String(session.awakenings),
                    })}
                  </span>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
