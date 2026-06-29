"use client";

/**
 * v1.25.3 — per-instrument screener trend chart.
 *
 * v1.25.5 — aligned to the dashboard's chart language exactly: a single
 * `type="monotone"` line over the primary colour with a soft gradient area
 * fill beneath (same `fillOpacity` + margins the dashboard line charts use),
 * the shared grid / axis tokens, and `RichChartTooltip`. The earlier
 * severity-band `ReferenceArea`s — unique to this surface — are gone so it
 * reads like every other trend; the band still surfaces in the tooltip.
 *
 * One instrument at a time: PHQ-9 (0–27) and GAD-7 (0–21) have different ranges
 * and bands, so the parent toggles which series this paints.
 */
import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
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
  band: string;
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
        band: r.severityBand,
      }));
  }, [rows]);

  const animate = !prefersReducedMotion();
  const primary = "var(--primary)";
  const gradientId = `mh-trend-${instrument}`;

  if (points.length === 0) {
    return (
      <p className="text-muted-foreground py-10 text-center text-sm">
        {t("mentalHealth.history.empty")}
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT_PX}>
      <ComposedChart
        data={points}
        margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={primary} stopOpacity={0.18} />
            <stop offset="95%" stopColor={primary} stopOpacity={0} />
          </linearGradient>
        </defs>
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
              {
                name: t("mentalHealth.history.bandLabel"),
                value: t(`mentalHealth.band.${instrument}.${point.band}`),
                color: "var(--muted-foreground)",
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
        <Area
          type="monotone"
          dataKey="value"
          stroke="none"
          fill={`url(#${gradientId})`}
          isAnimationActive={animate}
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
