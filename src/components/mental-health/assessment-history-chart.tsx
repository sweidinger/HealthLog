"use client";

/**
 * v1.25.3 — per-instrument screener trend chart, in the dashboard's visual
 * language (mirrors `labs/lab-biomarker-chart.tsx`). A single line of the total
 * score over `takenAt`, with the instrument's severity bands painted as stacked
 * MUTED `ReferenceArea`s (increasing opacity toward the top, all in the
 * primary/muted family) so the reader sees "where this score sits" WITHOUT a
 * danger palette — never an alarm colour (the no-alarming-colour rule the labs
 * chart documents).
 *
 * One instrument at a time: PHQ-9 (0–27) and GAD-7 (0–21) have different ranges
 * and bands, so the parent toggles which series + band set this paints.
 */
import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { RichChartTooltip, type RichTooltipRow } from "../charts/chart-tooltip";
import { CHART_HEIGHT_PX } from "@/lib/charts/constants";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { formatDateShort } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { INSTRUMENTS } from "@/lib/mental-health/instruments";

import type { AssessmentRow, InstrumentId } from "./types";

interface ChartPoint {
  timestamp: number;
  value: number;
}

export function AssessmentHistoryChart({
  instrument,
  rows,
}: {
  instrument: InstrumentId;
  /** Rows for THIS instrument, any order (sorted internally, ascending time). */
  rows: AssessmentRow[];
}) {
  const { t } = useTranslations();
  const def = INSTRUMENTS[instrument];

  const points = useMemo<ChartPoint[]>(() => {
    return [...rows]
      .sort(
        (a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime(),
      )
      .map((r) => ({
        timestamp: new Date(r.takenAt).getTime(),
        value: r.totalScore,
      }));
  }, [rows]);

  const animate = !prefersReducedMotion();
  const primary = "var(--primary)";

  if (points.length === 0) {
    return (
      <p className="text-muted-foreground py-10 text-center text-sm">
        {t("mentalHealth.history.empty")}
      </p>
    );
  }

  // Severity bands as stacked muted areas — opacity climbs with severity so the
  // higher bands read "heavier" without ever painting red. The whole y-range is
  // the instrument's 0..maxScore so the bands tile the plot.
  const bandCount = def.bands.length;

  return (
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
        {def.bands.map((band, i) => (
          <ReferenceArea
            key={band.key}
            y1={band.min}
            // Extend the top band to the instrument max so the last slice fills.
            y2={i === bandCount - 1 ? def.maxScore : band.max + 1}
            fill={primary}
            // 0.04 → ~0.16 across the bands: muted, monochrome, never alarm.
            fillOpacity={0.04 + (i / Math.max(1, bandCount - 1)) * 0.12}
            stroke="none"
            ifOverflow="extendDomain"
          />
        ))}
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
          domain={[0, def.maxScore]}
          allowDecimals={false}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          stroke="var(--border)"
          width={32}
        />
        <Tooltip
          content={(props) => {
            const active = props.active ?? false;
            const payload = props.payload as
              ReadonlyArray<{ payload?: ChartPoint }> | undefined;
            const point = payload?.[0]?.payload;
            if (!active || !point) {
              return <RichChartTooltip active={false} rows={[]} />;
            }
            const rowsOut: RichTooltipRow[] = [
              {
                name: t("mentalHealth.history.totalLabel"),
                value: String(point.value),
                color: primary,
              },
            ];
            return (
              <RichChartTooltip
                active
                label={formatDateShort(new Date(point.timestamp))}
                rows={rowsOut}
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
  );
}
