"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { CHART_HEIGHT_PX } from "@/lib/charts/constants";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { formatDateShort } from "@/lib/format";
import { formatLabValue } from "@/lib/labs/format-value";
import { useTranslations } from "@/lib/i18n/context";

import { RichChartTooltip, type RichTooltipRow } from "../charts/chart-tooltip";
import type { LabResultDto } from "./types";

/**
 * v1.18.1 — per-biomarker trend chart, in the dashboard's visual language.
 *
 * Replaces the hand-rolled 72×20 SVG sparkline with a proper Recharts
 * `ComposedChart`: a single line over time, the catalog reference window
 * painted as a shaded `ReferenceArea` band with dashed bound lines, range
 * tabs (30 / 90 / 365 / all), and the shared rich tooltip. The band uses a
 * MUTED primary fill — never a danger colour — honouring the no-alarming-
 * colour rule. Every reading carries the same y-axis unit because a chart is
 * one biomarker only.
 */

const RANGE_DAYS = [
  { key: "30", days: 30 },
  { key: "90", days: 90 },
  { key: "365", days: 365 },
  { key: "all", days: 0 },
] as const;

type RangeKey = (typeof RANGE_DAYS)[number]["key"];

interface ChartPoint {
  timestamp: number;
  value: number;
}

export function LabBiomarkerChart({
  readings,
  unit,
  lowerBound,
  upperBound,
}: {
  /** Readings for this biomarker, any order (sorted internally). */
  readings: LabResultDto[];
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
}) {
  const { t } = useTranslations();
  const [range, setRange] = useState<RangeKey>("365");
  // Capture "now" once at mount so the recency filter stays pure across
  // re-renders (an inline `Date.now()` in render is impure).
  const [nowMs] = useState(() => Date.now());

  const points = useMemo<ChartPoint[]>(() => {
    // v1.18.9 — qualitative readings (numeric value null) have nothing to plot;
    // drop them so the line never renders a NaN / zero point. A series of only
    // qualitative readings yields no points → the honest empty state below.
    const sorted = [...readings]
      .filter((r): r is LabResultDto & { value: number } => r.value !== null)
      .sort(
        (a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime(),
      );
    const days = RANGE_DAYS.find((r) => r.key === range)?.days ?? 0;
    const filtered =
      days > 0
        ? sorted.filter((r) => {
            const ageMs = nowMs - new Date(r.takenAt).getTime();
            return ageMs <= days * 24 * 60 * 60 * 1000;
          })
        : sorted;
    return filtered.map((r) => ({
      timestamp: new Date(r.takenAt).getTime(),
      value: r.value,
    }));
  }, [readings, range, nowMs]);

  // Y domain wraps both the data and the reference window so the band is
  // always visible even when every reading sits inside it.
  const yDomain = useMemo<[number, number]>(() => {
    const values = points.map((p) => p.value);
    const candidates = [...values];
    if (lowerBound != null) candidates.push(lowerBound);
    if (upperBound != null) candidates.push(upperBound);
    if (candidates.length === 0) return [0, 1];
    const min = Math.min(...candidates);
    const max = Math.max(...candidates);
    const pad = (max - min || Math.abs(max) || 1) * 0.1;
    return [min - pad, max + pad];
  }, [points, lowerBound, upperBound]);

  const animate = !prefersReducedMotion();
  const primary = "var(--primary)";

  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-1">
        {RANGE_DAYS.map((r) => (
          <Button
            key={r.key}
            size="sm"
            variant={range === r.key ? "secondary" : "ghost"}
            aria-pressed={range === r.key}
            className="h-7 px-2 text-xs"
            onClick={() => setRange(r.key)}
          >
            {t(`labs.chart.range.${r.key}`)}
          </Button>
        ))}
      </div>

      {points.length === 0 ? (
        <p className="text-muted-foreground py-10 text-center text-sm">
          {t("labs.chart.empty")}
        </p>
      ) : (
        <div>
          <ResponsiveContainer width="100%" height={CHART_HEIGHT_PX}>
            <ComposedChart
              data={points}
              margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--border)"
                vertical={false}
              />
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(ts: number) => formatDateShort(new Date(ts))}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                stroke="var(--border)"
                minTickGap={32}
              />
              <YAxis
                domain={yDomain}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                stroke="var(--border)"
                width={44}
                tickFormatter={(v: number) => formatLabValue(v)}
              />
              {/* Reference window — muted band + dashed bounds. No alarm
                  colour: the in/out verdict is shown by the neutral badge,
                  not by painting the chart red. */}
              {lowerBound != null && upperBound != null ? (
                <ReferenceArea
                  y1={lowerBound}
                  y2={upperBound}
                  fill={primary}
                  fillOpacity={0.1}
                  stroke="none"
                />
              ) : null}
              {lowerBound != null ? (
                <ReferenceLine
                  y={lowerBound}
                  stroke={primary}
                  strokeOpacity={0.4}
                  strokeDasharray="4 4"
                />
              ) : null}
              {upperBound != null ? (
                <ReferenceLine
                  y={upperBound}
                  stroke={primary}
                  strokeOpacity={0.4}
                  strokeDasharray="4 4"
                />
              ) : null}
              <Tooltip
                content={(props) => {
                  const active = props.active ?? false;
                  const payload = props.payload as
                    ReadonlyArray<{ payload?: ChartPoint }> | undefined;
                  const point = payload?.[0]?.payload;
                  if (!active || !point) {
                    return <RichChartTooltip active={false} rows={[]} />;
                  }
                  const rows: RichTooltipRow[] = [
                    {
                      name: t("labs.chart.valueLabel"),
                      value: `${formatLabValue(point.value)} ${unit}`,
                      color: primary,
                    },
                  ];
                  return (
                    <RichChartTooltip
                      active
                      label={formatDateShort(new Date(point.timestamp))}
                      rows={rows}
                    />
                  );
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke={primary}
                strokeWidth={2}
                dot={{ r: 3, fill: primary }}
                activeDot={{ r: 5 }}
                isAnimationActive={animate}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
