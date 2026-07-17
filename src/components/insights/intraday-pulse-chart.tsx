"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
} from "recharts";

import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { userDayKey } from "@/lib/tz/format";
import { TileHeader } from "@/components/insights/tile-header";
import type {
  IntradayHrBucket,
  TensionWindow,
} from "@/lib/analytics/intraday-pulse";

/** Slim DTO the intraday route returns (type-only — no server code bundled). */
interface IntradayPulseDto {
  dateKey: string;
  bucketMinutes: number;
  series: IntradayHrBucket[];
  baseline: number | null;
  baselineSource: "resting" | "proxy" | "none";
  tension: TensionWindow | null;
}

/** Minutes-since-midnight → "HH:mm" wall-clock label. */
function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const AXIS_TICKS = [0, 360, 720, 1080, 1440];

/**
 * S11 — the intraday pulse "shape of the day" layer inside the pulse insight.
 *
 * Charts one local day's 10-minute mean heart rate (computed on demand from
 * raw), with the personal resting baseline drawn as a reference line and any
 * detected elevated-at-rest ("tension") window softly shaded. Copy is cautious
 * and non-diagnostic — "possible tension", never a stress score. Empty / no-
 * baseline days render an honest one-liner rather than an empty grid.
 */
export function IntradayPulseChart({
  userTimezone,
}: {
  userTimezone?: string;
}) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const tz = userTimezone ?? "Europe/Berlin";
  const dateKey = userDayKey(new Date(), tz);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.insightsPulseIntraday(dateKey),
    queryFn: () =>
      apiGet<IntradayPulseDto>(`/api/insights/pulse/intraday?date=${dateKey}`),
    enabled: isAuthenticated,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const chartData = useMemo(
    () =>
      (data?.series ?? []).map((b) => ({
        minute: b.startMinute,
        label: minuteLabel(b.startMinute),
        bpm: b.mean,
      })),
    [data?.series],
  );

  const caption = data?.tension
    ? t(`insights.intradayPulse.tension.${data.tension.partOfDay}`)
    : t("insights.intradayPulse.caption");

  return (
    <div
      data-slot="intraday-pulse-chart"
      // `.metric-accent` — the tension layer's identity edge on the CARD
      // shell only (`--tile-stress`, the wellness vocabulary's autonomic
      // hue, per the plan's §3.6 hue-family call); the chart inside stays
      // untouched. The same hue marks the `tension_window` rail card, so
      // the two S11 surfaces read as one family.
      className="bg-card metric-accent space-y-1.5 rounded-xl border p-4"
      style={{ "--tile-hue": "var(--tile-stress)" } as React.CSSProperties}
    >
      <TileHeader icon={Activity} title={t("insights.intradayPulse.title")} />
      <p className="text-muted-foreground text-xs leading-snug">{caption}</p>

      {isLoading ? (
        <div className="bg-muted/40 h-44 animate-pulse rounded-lg motion-reduce:animate-none" />
      ) : chartData.length === 0 ? (
        <div className="text-muted-foreground flex h-44 items-center justify-center rounded-lg border border-dashed text-sm">
          {t("insights.intradayPulse.empty")}
        </div>
      ) : (
        <div className="touch-pan-y">
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient
                  id="intradayPulseFill"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0.3}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--border)"
                opacity={0.5}
              />
              <XAxis
                dataKey="minute"
                type="number"
                domain={[0, 1440]}
                ticks={AXIS_TICKS}
                tickFormatter={minuteLabel}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                domain={["dataMin - 10", "dataMax + 10"]}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                unit=" bpm"
                width={52}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: "0.5rem",
                  fontSize: "0.875rem",
                }}
                labelFormatter={(minute) => minuteLabel(Number(minute))}
                formatter={(value) => [`${value} bpm`, t("charts.pulse")]}
              />
              {data?.tension ? (
                <ReferenceArea
                  x1={data.tension.startMinute}
                  x2={data.tension.endMinute}
                  fill="var(--warning)"
                  fillOpacity={0.14}
                  ifOverflow="extendDomain"
                />
              ) : null}
              {data?.baseline != null ? (
                <ReferenceLine
                  y={data.baseline}
                  stroke="var(--muted-foreground)"
                  strokeDasharray="5 5"
                  strokeOpacity={0.7}
                  label={{
                    value: t("insights.intradayPulse.baseline"),
                    position: "insideTopLeft",
                    fill: "var(--muted-foreground)",
                    fontSize: 10,
                  }}
                />
              ) : null}
              <Area
                type="monotone"
                dataKey="bpm"
                stroke="var(--chart-1)"
                strokeWidth={2}
                fill="url(#intradayPulseFill)"
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
