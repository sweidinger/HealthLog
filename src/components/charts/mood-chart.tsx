"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceArea,
  ReferenceLine,
} from "recharts";
import { Loader2 } from "lucide-react";
import { useState, useMemo, useId } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { formatDateShort } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import type { DataSummary } from "@/lib/analytics/trends";
import {
  bucketTimeSeries,
  pickBucket,
  type ChartBucketType,
} from "@/lib/charts/bucket-time-series";
import { RichChartTooltip, type RichTooltipRow } from "./chart-tooltip";
import { ChartEmptyState } from "./chart-empty-state";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { shiftDailySeriesForward } from "@/lib/charts/comparison-shift";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";

// --- Types ---

interface MoodAnalyticsData {
  entries: Array<{ date: string; score: number; samples: number }>;
  summary: DataSummary;
}

interface ChartDataPoint {
  date: string;
  timestamp: number;
  pointIndex: number;
  score: number;
  ma?: number;
  trend?: number;
  /** v1.4.16 phase B8 — prior-period overlay value. */
  scoreCompare?: number;
}

interface MoodChartProps {
  title?: string;
  /**
   * v1.4.16 phase B5c — compact mode for embedding inside the
   * RecommendationCard. Hides the range tabs / toggle row and shrinks
   * padding. Tooltip stays intact.
   */
  mini?: boolean;
  /**
   * v1.4.16 phase B5c — pin the chart to a specific rationale data
   * window regardless of any parent UI state.
   */
  windowOverride?: "last7days" | "last30days" | "last90days" | "allTime";
  /**
   * v1.4.16 phase B8 — when set to "lastMonth" / "lastYear", overlay a
   * dimmed prior-period mood line beneath the current series. Same
   * shift mechanic the BP/weight/pulse chart uses; the mood score is
   * a single metric so only one comparison line is drawn.
   */
  compareBaseline?: ComparisonBaseline;
}

// --- Constants ---

const TIME_RANGES_KEYS = [
  {
    labelKey: "charts.points7Label",
    points: 7,
    titleKey: "charts.points7Title",
  },
  {
    labelKey: "charts.points30Label",
    points: 30,
    titleKey: "charts.points30Title",
  },
  {
    labelKey: "charts.points90Label",
    points: 90,
    titleKey: "charts.points90Title",
  },
  {
    labelKey: "charts.pointsAllLabel",
    points: 0,
    titleKey: "charts.pointsAllTitle",
  },
] as const;

// MOOD_LABELS built dynamically via t() in the component

const VALUE_BANDS = [
  { min: 1, max: 2, color: "#ff5555", opacity: 0.16 },
  { min: 2, max: 3, color: "#ffb86c", opacity: 0.18 },
  { min: 3, max: 5, color: "#50fa7b", opacity: 0.2 },
] as const;

const COLOR_MAIN = "#d6acff";
const COLOR_MA = "#ff79c6";
const COLOR_TREND = "#8be9fd";

// --- Helpers ---

function dayKeyToTimestamp(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 12, 0, 0);
}

function movingAverageByPoints(
  data: Array<{ date: Date; value: number }>,
  windowSize: number,
): Array<{ date: Date; value: number }> {
  if (data.length === 0) return [];

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());

  return sorted.map((point, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const window = sorted.slice(start, index + 1);
    const avg =
      window.reduce((sum, item) => sum + item.value, 0) / window.length;
    return {
      date: point.date,
      value: Math.round(avg * 100) / 100,
    };
  });
}

function buildTrendLine(data: Array<{ date: Date; value: number }>): {
  points: Array<{ date: Date; value: number }>;
  slopePerDay: number;
} | null {
  if (data.length < 2) return null;

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const startTime = sorted[0].date.getTime();
  const points = sorted.map((p) => ({
    x: (p.date.getTime() - startTime) / 86400000,
    y: p.value,
  }));

  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  return {
    points: sorted.map((p) => ({
      date: p.date,
      value:
        Math.round(
          (intercept + slope * ((p.date.getTime() - startTime) / 86400000)) *
            100,
        ) / 100,
    })),
    slopePerDay: slope,
  };
}

// --- Aggregation helpers (exported for unit tests) ---

interface MoodEntryDay {
  date: string; // "YYYY-MM-DD" Berlin
  score: number;
}

/**
 * Pick the time bucket for a window of mood entries based on the same
 * thresholds the dashboard charts use. Pure: no DOM/i18n side-effects.
 *
 * - ≤ 90 days → "day"   (raw daily averages)
 * - 91-730   → "week"  (ISO weekly mean)
 * - > 730    → "month" (Berlin calendar monthly mean)
 */
export function pickMoodBucket(entries: MoodEntryDay[]): ChartBucketType {
  if (entries.length < 2) return "day";
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const firstTs = dayKeyToTimestamp(sorted[0].date);
  const lastTs = dayKeyToTimestamp(sorted[sorted.length - 1].date);
  const rangeDays = Math.round((lastTs - firstTs) / (24 * 60 * 60 * 1000));
  return pickBucket(rangeDays);
}

/**
 * Aggregate daily mood entries into the bucket chosen by `pickMoodBucket`.
 * Returns `{ timestamp, score }` rows so the chart can render them
 * without re-formatting. Days/weeks/months without an observation are
 * skipped, never emitted as 0.
 *
 * Pure & deterministic so the unit test can pin the exact aggregated
 * mean per bucket.
 */
export function aggregateMoodEntries(entries: MoodEntryDay[]): {
  bucket: ChartBucketType;
  points: Array<{ timestamp: number; score: number }>;
} {
  if (entries.length === 0) return { bucket: "day", points: [] };

  const bucket = pickMoodBucket(entries);
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));

  if (bucket === "day") {
    return {
      bucket,
      points: sorted.map((entry) => ({
        timestamp: dayKeyToTimestamp(entry.date),
        score: entry.score,
      })),
    };
  }

  const out = bucketTimeSeries(
    sorted.map((entry) => ({
      timestamp: dayKeyToTimestamp(entry.date),
      values: { score: entry.score },
    })),
    { bucket },
  );

  return {
    bucket,
    points: out.points.map((point) => ({
      timestamp: point.timestamp,
      score: point.values.score,
    })),
  };
}

// --- Component ---

const MINI_RANGE_POINTS: Record<
  NonNullable<MoodChartProps["windowOverride"]>,
  number
> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
  allTime: 0,
};

export function MoodChart({
  title,
  mini = false,
  windowOverride,
  compareBaseline = "none",
}: MoodChartProps) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const initialRangePoints = windowOverride
    ? MINI_RANGE_POINTS[windowOverride]
    : 30;
  const [rangePoints, setRangePoints] = useState(initialRangePoints);
  const [showMA, setShowMA] = useState(false);
  const [showTrend, setShowTrend] = useState(false);
  const [showBands, setShowBands] = useState(false);
  const maToggleId = useId();
  const trendToggleId = useId();
  const bandsToggleId = useId();

  const displayTitle = title ?? t("charts.mood");

  const { data, isLoading } = useQuery({
    queryKey: ["mood-chart-data"],
    queryFn: async (): Promise<MoodAnalyticsData> => {
      const res = await fetch("/api/mood/analytics");
      if (!res.ok) throw new Error("Failed to fetch mood analytics");
      const json = await res.json();
      return json.data as MoodAnalyticsData;
    },
    enabled: isAuthenticated,
  });

  const chartData = useMemo((): ChartDataPoint[] | undefined => {
    if (!data?.entries?.length) return undefined;

    const allPoints: ChartDataPoint[] = data.entries
      .map((entry) => ({
        date: formatDateShort(new Date(dayKeyToTimestamp(entry.date))),
        timestamp: dayKeyToTimestamp(entry.date),
        pointIndex: 0,
        score: entry.score,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const sliced = rangePoints > 0 ? allPoints.slice(-rangePoints) : allPoints;

    // v1.4.15 Fix 3: parity with health-chart's auto-bucketing. Other
    // dashboard charts (BP, weight, pulse) auto-aggregate to weekly /
    // monthly when the visible range is long enough that drawing every
    // daily point would clutter the chart; the mood chart used to show
    // raw points only, which made multi-month windows unreadable.
    // Using the same `pickBucket()` thresholds the rest of the
    // dashboard uses (≤90d → day, 91-730d → week, >730d → month) keeps
    // the bucketing chip consistent across metrics.
    const rangeDays =
      sliced.length < 2
        ? 0
        : Math.round(
            (sliced[sliced.length - 1].timestamp - sliced[0].timestamp) /
              (24 * 60 * 60 * 1000),
          );
    const bucketType = pickBucket(rangeDays);

    const visibleData: ChartDataPoint[] =
      bucketType === "day"
        ? sliced
        : bucketTimeSeries(
            sliced.map((p) => ({
              timestamp: p.timestamp,
              values: { score: p.score },
            })),
            { bucket: bucketType },
          ).points.map((point) => ({
            date: formatDateShort(new Date(point.timestamp)),
            timestamp: point.timestamp,
            pointIndex: 0,
            score: point.values.score,
          }));

    const enriched: ChartDataPoint[] = visibleData.map((d, index) => ({
      ...d,
      pointIndex: index,
    }));

    if (showMA) {
      const scoreData = enriched.map((d) => ({
        date: new Date(d.timestamp),
        value: d.score,
      }));

      if (scoreData.length >= 2) {
        const ma = movingAverageByPoints(scoreData, 7);
        for (const point of ma) {
          const pointTimestamp = point.date.getTime();
          const existing = enriched.find((d) => d.timestamp === pointTimestamp);
          if (existing) {
            existing.ma = point.value;
          }
        }
      }
    }

    if (showTrend) {
      const scoreData = enriched.map((d) => ({
        date: new Date(d.timestamp),
        value: d.score,
      }));

      if (scoreData.length >= 2) {
        const trend = buildTrendLine(scoreData);
        if (trend) {
          for (const point of trend.points) {
            const pointTimestamp = point.date.getTime();
            const existing = enriched.find(
              (d) => d.timestamp === pointTimestamp,
            );
            if (existing) {
              existing.trend = point.value;
            }
          }
        }
      }
    }

    return enriched;
  }, [data, rangePoints, showMA, showTrend]);

  /**
   * v1.4.16 phase B8 — comparison overlay merged into chartData.
   *
   * Same mechanic as HealthChart: shift the full mood-entries history
   * forward by 30 / 365 days, key by the existing `date` formatter, and
   * stamp the prior-period score onto each visible point as
   * `scoreCompare`. The Recharts <Line dataKey="scoreCompare" />
   * below renders the dimmed dashed overlay.
   */
  const chartDataWithCompare = useMemo<ChartDataPoint[] | undefined>(() => {
    if (!chartData || compareBaseline === "none") return chartData;
    if (!data?.entries?.length) return chartData;

    const shifted = shiftDailySeriesForward(
      data.entries.map((entry) => ({
        timestamp: dayKeyToTimestamp(entry.date),
        score: entry.score,
      })),
      compareBaseline,
    );

    const shiftedByDay = new Map<string, number>();
    for (const row of shifted) {
      const dayKey = formatDateShort(new Date(row.timestamp));
      if (typeof row.score === "number" && Number.isFinite(row.score)) {
        shiftedByDay.set(dayKey, row.score);
      }
    }

    return chartData.map((point) => {
      const compareValue = shiftedByDay.get(point.date);
      if (typeof compareValue === "number" && Number.isFinite(compareValue)) {
        return { ...point, scoreCompare: compareValue };
      }
      return point;
    });
  }, [chartData, compareBaseline, data]);

  const hasComparisonData = useMemo(() => {
    if (compareBaseline === "none" || !chartDataWithCompare) return false;
    return chartDataWithCompare.some((point) =>
      typeof point.scoreCompare === "number"
        ? Number.isFinite(point.scoreCompare)
        : false,
    );
  }, [chartDataWithCompare, compareBaseline]);

  // Mirror the activeBucket calculation from health-chart so the chip
  // in the header reflects the *same* aggregation chartData used.
  // Computed independently of chartData so an empty/loading dataset
  // doesn't crash the chip render.
  const activeBucket: ChartBucketType = useMemo(() => {
    if (!data?.entries?.length) return "day";
    const sorted = [...data.entries].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    const sliced = rangePoints > 0 ? sorted.slice(-rangePoints) : sorted;
    if (sliced.length < 2) return "day";
    const firstTs = dayKeyToTimestamp(sliced[0].date);
    const lastTs = dayKeyToTimestamp(sliced[sliced.length - 1].date);
    const rangeDays = Math.round((lastTs - firstTs) / (24 * 60 * 60 * 1000));
    return pickBucket(rangeDays);
  }, [data, rangePoints]);

  const maxPointIndex = Math.max(0, (chartData?.length ?? 1) - 1);

  const moodLabels: Record<number, string> = {
    1: t("charts.moodLabel1"),
    2: t("charts.moodLabel2"),
    3: t("charts.moodLabel3"),
    4: t("charts.moodLabel4"),
    5: t("charts.moodLabel5"),
  };

  // v1.4.18 — emoji glyph map removed. Marc explicitly rejected
  // smileys in the mood chart; the line now uses plain Recharts dots
  // and the y-axis already labels each integer (very low / low / okay
  // / good / great) so the chart is fully scannable without a glyph.

  const formatMoodTick = (value: number): string => {
    return moodLabels[value] ?? String(value);
  };

  const formatTooltipValue = (value: number): string => {
    const rounded = Math.round(value * 10) / 10;
    const label = moodLabels[Math.round(value)];
    return label ? `${rounded} (${label})` : String(rounded);
  };

  // v1.4.16 B1a — personal mood baseline (median over visible window).
  const personalBaseline = useMemo<number | null>(() => {
    if (!chartData?.length || chartData.length < 5) return null;
    const sorted = chartData.map((d) => d.score).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }, [chartData]);

  const animationsEnabled = !prefersReducedMotion();

  if (!isLoading && !data?.entries?.length) return null;

  return (
    <Card data-slot={mini ? "chart-mini" : undefined}>
      <CardHeader className={mini ? "pb-1" : "pb-2"}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle
              className={
                mini
                  ? "text-muted-foreground text-[10px] font-medium tracking-wider uppercase"
                  : "text-base font-medium"
              }
            >
              {displayTitle}
            </CardTitle>
            {activeBucket !== "day" && !mini && (
              <span className="bg-muted/40 text-muted-foreground rounded-md px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                {t(
                  activeBucket === "week"
                    ? "charts.bucketWeekly"
                    : "charts.bucketMonthly",
                )}
              </span>
            )}
            {/* v1.4.16 phase B8 — comparison caption (mood). */}
            {!mini && compareBaseline !== "none" && hasComparisonData && (
              <span
                className="text-dracula-purple bg-dracula-purple/10 rounded-md border border-current/30 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
                data-slot="chart-compare-caption"
              >
                {t(
                  compareBaseline === "lastMonth"
                    ? "comparison.captionLastMonth"
                    : "comparison.captionLastYear",
                )}
              </span>
            )}
            {!mini && compareBaseline !== "none" && !hasComparisonData && (
              <span
                className="text-muted-foreground bg-muted/40 rounded-md px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
                data-slot="chart-compare-unavailable"
              >
                {t(
                  compareBaseline === "lastMonth"
                    ? "comparison.unavailable.lastMonth"
                    : "comparison.unavailable.lastYear",
                )}
              </span>
            )}
          </div>
          {!mini && (
            <div className="flex gap-1">
              {TIME_RANGES_KEYS.map((r) => (
                <Button
                  key={r.labelKey}
                  variant={rangePoints === r.points ? "default" : "ghost"}
                  size="sm"
                  className="min-h-11 px-3 text-xs"
                  onClick={() => setRangePoints(r.points)}
                  title={t(r.titleKey)}
                  data-slot="chart-range-tab"
                >
                  {t(r.labelKey)}
                </Button>
              ))}
            </div>
          )}
        </div>
        {!mini && (
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <Switch
                id={maToggleId}
                checked={showMA}
                onCheckedChange={setShowMA}
              />
              <Label htmlFor={maToggleId} className="cursor-pointer text-xs">
                {t("charts.moodMA")}
              </Label>
            </div>
            <div className="flex items-center gap-1.5">
              <Switch
                id={trendToggleId}
                checked={showTrend}
                onCheckedChange={setShowTrend}
              />
              <Label
                htmlFor={trendToggleId}
                className="cursor-pointer text-xs"
              >
                {t("charts.trend")}
              </Label>
            </div>
            <div className="flex items-center gap-1.5">
              <Switch
                id={bandsToggleId}
                checked={showBands}
                onCheckedChange={setShowBands}
              />
              <Label
                htmlFor={bandsToggleId}
                className="cursor-pointer text-xs"
              >
                {t("charts.targetRanges")}
              </Label>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {/* v1.4.18 — gradient defs removed; clean line only. */}
        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="text-primary h-6 w-6 animate-spin" />
          </div>
        ) : !chartData?.length ? (
          <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
            {t("charts.noData")}
          </div>
        ) : chartData.length < 3 ? (
          // v1.4.16 B1a — sparse-data placeholder consistent with the
          // BP/weight/pulse charts.
          <ChartEmptyState
            title={t("charts.emptyStateTitle")}
            description={t("charts.emptyStateDescription")}
            height={280}
          />
        ) : (
          <div className={`${mini ? "h-[140px]" : "h-[280px]"} touch-pan-y`}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={chartDataWithCompare ?? chartData}
                margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  opacity={0.5}
                />
                {showBands &&
                  VALUE_BANDS.map((band) => (
                    <ReferenceArea
                      key={`band-${band.min}-${band.max}`}
                      y1={band.min}
                      y2={band.max}
                      fill={band.color}
                      fillOpacity={band.opacity}
                      strokeOpacity={0}
                      ifOverflow="discard"
                    />
                  ))}
                {personalBaseline != null && (
                  <ReferenceLine
                    y={personalBaseline}
                    stroke={COLOR_MAIN}
                    strokeDasharray="2 4"
                    strokeOpacity={0.4}
                    strokeWidth={1}
                    ifOverflow="discard"
                    label={{
                      value: t("charts.personalBaseline"),
                      position: "insideTopLeft",
                      fill: "var(--muted-foreground)",
                      fontSize: 10,
                      opacity: 0.7,
                    }}
                  />
                )}
                <XAxis
                  type="number"
                  dataKey="pointIndex"
                  domain={[0, maxPointIndex]}
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value: number) =>
                    formatDateShort(
                      new Date(
                        chartData[Math.round(value)]?.timestamp ?? Date.now(),
                      ),
                      true,
                    )
                  }
                  interval="preserveStartEnd"
                  padding={{ left: 10, right: 10 }}
                  tickMargin={10}
                />
                <YAxis
                  domain={[1, 5]}
                  ticks={[1, 2, 3, 4, 5]}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={65}
                  tickMargin={6}
                  tickFormatter={formatMoodTick}
                />
                <Tooltip
                  cursor={{
                    stroke: "var(--muted-foreground)",
                    strokeOpacity: 0.3,
                    strokeDasharray: "3 3",
                  }}
                  content={(props) => {
                    const {
                      active,
                      payload,
                      label: rechartsLabel,
                    } = props as unknown as {
                      active?: boolean;
                      payload?: Array<{
                        name?: string;
                        value?: number;
                        color?: string;
                        dataKey?: string;
                        payload?: ChartDataPoint;
                      }>;
                      label?: number;
                    };
                    if (!active || !payload?.length) return null;
                    const ts =
                      payload[0]?.payload?.timestamp ??
                      (typeof rechartsLabel === "number"
                        ? chartData?.[Math.round(rechartsLabel)]?.timestamp
                        : undefined);
                    const dateLabel = ts
                      ? formatDateShort(new Date(ts), true)
                      : "";
                    const rows: RichTooltipRow[] = [];
                    const hoverPoint = payload[0]?.payload as
                      | ChartDataPoint
                      | undefined;
                    for (const item of payload) {
                      if (typeof item.value !== "number") continue;
                      const dataKey = String(item.dataKey ?? "");
                      // Skip auxiliary lines (`ma`, `trend`,
                      // `scoreCompare`). Comparison value rendered as
                      // delta on the primary row + own row below.
                      if (
                        dataKey === "ma" ||
                        dataKey === "trend" ||
                        dataKey === "scoreCompare"
                      )
                        continue;
                      let delta: string | undefined;
                      const compareValue =
                        compareBaseline !== "none" && hoverPoint
                          ? hoverPoint.scoreCompare
                          : undefined;
                      if (
                        compareBaseline !== "none" &&
                        typeof compareValue === "number" &&
                        Number.isFinite(compareValue)
                      ) {
                        const diff = item.value - compareValue;
                        if (Math.abs(diff) < 0.05) {
                          delta = t("charts.deltaUnchanged");
                        } else {
                          const sign = diff > 0 ? "+" : "−";
                          const formatted = `${sign}${Math.abs(diff).toFixed(
                            1,
                          )}`;
                          delta = t(
                            compareBaseline === "lastMonth"
                              ? "comparison.deltaVs.lastMonth"
                              : "comparison.deltaVs.lastYear",
                          ).replace("{delta}", formatted);
                        }
                      } else if (personalBaseline != null) {
                        const diff = item.value - personalBaseline;
                        if (Math.abs(diff) < 0.05) {
                          delta = t("charts.deltaUnchanged");
                        } else {
                          const sign = diff > 0 ? "+" : "−";
                          const formatted = `${sign}${(
                            Math.abs(diff)
                          ).toFixed(1)}`;
                          delta = t("charts.deltaVsBaseline").replace(
                            "{delta}",
                            formatted,
                          );
                        }
                      }
                      rows.push({
                        name: t("charts.moodScore"),
                        value: formatTooltipValue(item.value),
                        color: item.color ?? COLOR_MAIN,
                        delta,
                      });
                      if (
                        compareBaseline !== "none" &&
                        typeof compareValue === "number" &&
                        Number.isFinite(compareValue)
                      ) {
                        rows.push({
                          name: `${t("charts.moodScore")} · ${t(
                            "comparison.tooltipPrior",
                          )}`,
                          value: formatTooltipValue(compareValue),
                          color: item.color ?? COLOR_MAIN,
                        });
                      }
                    }
                    if (rows.length === 0) return null;
                    return (
                      <RichChartTooltip
                        active
                        label={dateLabel}
                        rows={rows}
                      />
                    );
                  }}
                />
                {/* v1.4.18 — gradient Area removed; clean line only. */}
                <Line
                  type="monotone"
                  dataKey="score"
                  name="score"
                  stroke={COLOR_MAIN}
                  strokeWidth={2}
                  dot={{ r: 3, fill: COLOR_MAIN }}
                  activeDot={{ r: 5 }}
                  connectNulls
                  isAnimationActive={animationsEnabled}
                  animationDuration={animationsEnabled ? 600 : 0}
                  animationEasing="ease-out"
                />
                {showMA && (
                  <Line
                    type="monotone"
                    dataKey="ma"
                    name="ma"
                    stroke={COLOR_MA}
                    strokeWidth={1.5}
                    strokeDasharray="5 5"
                    dot={false}
                    connectNulls
                  />
                )}
                {showTrend && (
                  <Line
                    type="linear"
                    dataKey="trend"
                    name="trend"
                    stroke={COLOR_TREND}
                    strokeWidth={1}
                    strokeDasharray="8 4"
                    dot={false}
                    connectNulls
                  />
                )}
                {/* v1.4.16 phase B8 — comparison overlay (mood). Same
                    dimmed dashed treatment the BP/weight/pulse chart
                    uses; mood is a single metric so we only render
                    one overlay line. Suppressed when there's no prior
                    data via hasComparisonData. */}
                {compareBaseline !== "none" && hasComparisonData && (
                  <Line
                    type="monotone"
                    dataKey="scoreCompare"
                    name="scoreCompare"
                    stroke={COLOR_MAIN}
                    strokeWidth={1.25}
                    strokeDasharray="4 3"
                    strokeOpacity={0.45}
                    dot={false}
                    connectNulls
                    isAnimationActive={animationsEnabled}
                    animationDuration={animationsEnabled ? 600 : 0}
                    animationEasing="ease-out"
                    legendType="none"
                    data-slot="chart-compare-line-mood"
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
