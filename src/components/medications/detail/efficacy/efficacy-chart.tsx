"use client";

/**
 * v1.28 — the "Wirkung" target chart. Recharts consumer, so it is exported
 * through `chart-runtime` and loaded via `next/dynamic` at the call site (the
 * one-shared-chunk rule). Renders the target series over a span around the
 * medication's start with:
 *   - a faint population reference band (context, never a goal line),
 *   - shaded pause bands,
 *   - a vertical start marker + quiet dose-change markers,
 *   - the target line,
 *   - a faint adherence lane on a hidden right axis.
 * Strictly descriptive — no colour-coded verdict, no "good/bad" zones.
 */
import { useMemo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import { makeFormatters } from "@/lib/format-locale";
import { useTranslations } from "@/lib/i18n/context";

export interface EfficacyChartTarget {
  label: string;
  unit: string | null;
  referenceBand: { low: number; high: number } | null;
  series: { t: string; value: number }[];
}

export interface EfficacyChartProps {
  target: EfficacyChartTarget;
  startMs: number | null;
  doseChanges: { at: string; label: string }[];
  pauses: { from: string; to: string | null }[];
  adherence: { date: string; rate: number }[];
  timezone: string;
  startLabel: string;
  adherenceLabel: string;
  typicalRangeLabel: string;
}

const toMs = (iso: string): number => Date.parse(iso);

export function EfficacyChart({
  target,
  startMs,
  doseChanges,
  pauses,
  adherence,
  timezone,
  startLabel,
  adherenceLabel,
  typicalRangeLabel,
}: EfficacyChartProps) {
  const { locale } = useTranslations();
  const fmt = useMemo(
    () => makeFormatters(locale, timezone),
    [locale, timezone],
  );

  const seriesData = useMemo(
    () =>
      target.series
        .map((p) => ({ t: toMs(p.t), value: p.value }))
        .filter((p) => Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t),
    [target.series],
  );
  const adherenceData = useMemo(
    () =>
      adherence
        .map((p) => ({ t: toMs(p.date), rate: p.rate }))
        .filter((p) => Number.isFinite(p.t))
        .sort((a, b) => a.t - b.t),
    [adherence],
  );

  const domain = useMemo<[number, number] | null>(() => {
    const xs = [
      ...seriesData.map((p) => p.t),
      ...adherenceData.map((p) => p.t),
    ];
    if (xs.length === 0) return null;
    return [Math.min(...xs), Math.max(...xs)];
  }, [seriesData, adherenceData]);

  if (seriesData.length === 0 || !domain) return null;

  // An open pause runs to the chart's right edge (the latest datum); using the
  // domain max keeps the render pure (no `Date.now()` in the render body).
  const rightEdge = domain[1];
  return (
    <div className="touch-pan-y">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            opacity={0.5}
          />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={domain}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => fmt.date(new Date(v))}
          />
          <YAxis
            yAxisId="target"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={40}
            unit={target.unit ? ` ${target.unit}` : undefined}
          />
          <YAxis
            yAxisId="adherence"
            orientation="right"
            domain={[0, 100]}
            hide
          />

          {/* Population reference band — faint context, labelled "typical
              range", explicitly NOT a target line. */}
          {target.referenceBand ? (
            <ReferenceArea
              yAxisId="target"
              y1={target.referenceBand.low}
              y2={target.referenceBand.high}
              fill="var(--muted-foreground)"
              fillOpacity={0.08}
              stroke="none"
              label={{
                value: typicalRangeLabel,
                position: "insideTopLeft",
                fill: "var(--muted-foreground)",
                fontSize: 10,
              }}
            />
          ) : null}

          {/* Shaded pause bands. An open pause runs to now. */}
          {pauses.map((p, i) => (
            <ReferenceArea
              key={`pause-${i}`}
              yAxisId="target"
              x1={toMs(p.from)}
              x2={p.to ? toMs(p.to) : rightEdge}
              fill="var(--foreground)"
              fillOpacity={0.06}
              stroke="none"
            />
          ))}

          {/* Adherence lane — faint, hidden right axis. */}
          <Line
            yAxisId="adherence"
            data={adherenceData}
            dataKey="rate"
            name={adherenceLabel}
            type="stepAfter"
            stroke="var(--chart-4)"
            strokeWidth={1.5}
            strokeOpacity={0.5}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />

          {/* The target series. */}
          <Line
            yAxisId="target"
            data={seriesData}
            dataKey="value"
            name={target.label}
            type="monotone"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={{ r: 2, fill: "var(--chart-1)" }}
            activeDot={{ r: 4 }}
            connectNulls
            isAnimationActive={false}
          />

          {/* Start marker. */}
          {startMs !== null ? (
            <ReferenceLine
              yAxisId="target"
              x={startMs}
              stroke="var(--primary)"
              strokeWidth={1.5}
              label={{
                value: startLabel,
                position: "insideTopRight",
                fill: "var(--foreground)",
                fontSize: 10,
              }}
            />
          ) : null}

          {/* Dose-change markers — quiet, dashed. */}
          {doseChanges.map((d, i) => (
            <ReferenceLine
              key={`dose-${i}`}
              yAxisId="target"
              x={toMs(d.at)}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              strokeOpacity={0.6}
            />
          ))}

          <Tooltip
            contentStyle={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              fontSize: "0.8125rem",
            }}
            labelFormatter={(v) => fmt.date(new Date(Number(v)))}
            formatter={(value, name) => {
              const num = Number(value);
              const text =
                name === adherenceLabel
                  ? `${Math.round(num)}%`
                  : `${num}${target.unit ? ` ${target.unit}` : ""}`;
              return [text, String(name)];
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
