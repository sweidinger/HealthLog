"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { STAGE_COLORS } from "./sleep-stage-stacked-bar";

/**
 * v1.11.5 — last-night HYPNOGRAM (Marc directive: the phase-progression
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
 * Recharts stays (project rule). The stepped track is a `stepAfter` line
 * over a {t, lane} series built from each segment's [start, end] span.
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
}

export interface SleepHypnogramProps {
  session: SleepHypnogramSession;
}

/**
 * Lane order top → bottom. Awake highest, Deep lowest — depth increases
 * downward, matching Apple Health / Oura's "cityscape" convention.
 */
const LANE_ORDER = ["AWAKE", "IN_BED", "ASLEEP", "REM", "CORE", "DEEP"] as const;
const LANE_OF: Record<string, number> = Object.fromEntries(
  // Reverse-index so AWAKE (first) sits at the highest y value.
  LANE_ORDER.map((s, i) => [s, LANE_ORDER.length - 1 - i]),
);

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

  const stageLabels: Record<string, string> = {
    DEEP: t("insights.sleep.stages.deep"),
    REM: t("insights.sleep.stages.rem"),
    CORE: t("insights.sleep.stages.core"),
    ASLEEP: t("insights.sleep.stages.asleep"),
    AWAKE: t("insights.sleep.stages.awake"),
    IN_BED: t("insights.sleep.stages.inBed"),
  };

  // Build the stepped {t, lane} series: a point at each segment START and
  // END so a `stepAfter` line holds each stage's depth across its span.
  const data = useMemo(() => {
    const points: Array<{ t: number; lane: number }> = [];
    const sorted = [...session.segments]
      .filter((seg) => seg.stage != null && LANE_OF[seg.stage] !== undefined)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    for (const seg of sorted) {
      const lane = LANE_OF[seg.stage as string];
      points.push({ t: new Date(seg.start).getTime(), lane });
      points.push({ t: new Date(seg.end).getTime(), lane });
    }
    return points;
  }, [session.segments]);

  const domain: [number, number] = [
    new Date(session.start).getTime(),
    new Date(session.end).getTime(),
  ];

  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
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

  const hasTrack = data.length > 0;

  return (
    <Card data-slot="sleep-hypnogram">
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="text-sm font-medium">
            {t("insights.sleep.hypnogram.title")}
          </CardTitle>
          <span className="text-muted-foreground text-xs">
            {t("insights.sleep.hypnogram.subtitle", {
              asleep: formatMinutes(session.asleepMinutes, locale),
            })}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasTrack ? (
          <p
            className="text-muted-foreground py-8 text-center text-xs"
            data-slot="sleep-hypnogram-empty"
          >
            {t("insights.sleep.stages.unavailable")}
          </p>
        ) : (
          <>
            <div role="img" aria-label={ariaLabel}>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart
                  data={data}
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
                    stroke="var(--muted-foreground)"
                    fontSize={10}
                    tickFormatter={(v: number) => timeFmt.format(new Date(v))}
                  />
                  <YAxis
                    type="number"
                    dataKey="lane"
                    domain={[-0.5, LANE_ORDER.length - 0.5]}
                    ticks={LANE_ORDER.map(
                      (_, i) => LANE_ORDER.length - 1 - i,
                    )}
                    stroke="var(--muted-foreground)"
                    fontSize={10}
                    width={56}
                    tickFormatter={(v: number) => {
                      const stage = LANE_ORDER[LANE_ORDER.length - 1 - v];
                      return stageLabels[stage] ?? "";
                    }}
                  />
                  <Line
                    type="stepAfter"
                    dataKey="lane"
                    stroke="var(--dracula-cyan, #8be9fd)"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

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
      </CardContent>
    </Card>
  );
}
