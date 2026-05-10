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
  Legend,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import { Loader2 } from "lucide-react";
import { useState, useMemo, useId } from "react";
import { RichChartTooltip, type RichTooltipRow } from "./chart-tooltip";
import { ChartEmptyState } from "./chart-empty-state";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { formatDateShort } from "@/lib/format";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  bucketTimeSeries,
  pickBucket,
  type ChartBucketType,
} from "@/lib/charts/bucket-time-series";
import {
  computeWindowTrend,
  SPLIT_HALF_THRESHOLD_DAYS,
} from "@/lib/analytics/window-trend";
import {
  resolveMiniRangePoints,
  type DataWindow,
} from "./mini-window";
import { shiftDailySeriesForward } from "@/lib/charts/comparison-shift";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";

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

interface HealthChartProps {
  types: string[];
  title: string;
  colors?: string[];
  unit?: string;
  yAxisUnit?: string;
  valueMode?: "raw" | "bmi";
  yAxisWidth?: number;
  showYAxisUnit?: boolean;
  valueBands?: Array<{
    min: number;
    max: number;
    color: string;
    opacity?: number;
    strokeOpacity?: number;
  }>;
  targetZones?: Array<{
    min: number;
    max: number;
    color: string;
    opacity?: number;
    label?: string;
    textColor?: string;
    lineOpacity?: number;
  }>;
  /**
   * v1.4.16 phase B5c — compact chart mode used by the Oura-style
   * rationale card. Drops the range tabs, the moving-average / trend
   * / target-band toggle row, and shrinks padding. Tooltip + gradient
   * + personal-baseline behaviour stay intact so the small chart
   * still tells the same visual story.
   */
  mini?: boolean;
  /**
   * v1.4.16 phase B5c — pin the chart to a specific rationale data
   * window regardless of any parent UI state. Used by the rec-card's
   * mini-chart so it always renders the window the rec is based on.
   */
  windowOverride?: DataWindow;
  /**
   * v1.4.16 phase B8 — when set to "lastMonth" / "lastYear", paint a
   * dimmed prior-period overlay beneath the current series. The chart
   * already fetches the full measurement history; the overlay is
   * computed by `shiftDailySeriesForward` so the prior-period day at
   * 30 / 365 days back lands directly under its current-period sibling
   * on the visible x-axis.
   *
   * "none" or undefined renders the chart exactly as before — no
   * regression for users who keep the toggle off.
   */
  compareBaseline?: ComparisonBaseline;
}

interface ChartDataPoint {
  date: string;
  timestamp: number;
  pointIndex?: number;
  [key: string]: string | number | undefined;
}

interface MeasurementApiRow {
  measuredAt: string;
  value: number;
}

interface VisibleTargetZone {
  key: string;
  low: number;
  high: number;
  topPct: number;
  heightPct: number;
  color: string;
  opacity: number;
  label: string | undefined;
  textColor: string | undefined;
  lineOpacity: number;
}

const BASE_TYPE_LABEL_KEYS: Record<string, string> = {
  WEIGHT: "charts.weight",
  BLOOD_PRESSURE_SYS: "charts.systolic",
  BLOOD_PRESSURE_DIA: "charts.diastolic",
  PULSE: "charts.pulse",
  BODY_FAT: "charts.bodyFat",
  SLEEP_DURATION: "charts.sleep",
  ACTIVITY_STEPS: "charts.steps",
  BLOOD_GLUCOSE: "measurements.typeBloodGlucose",
  TOTAL_BODY_WATER: "charts.bodyWater",
  BONE_MASS: "charts.boneMass",
  OXYGEN_SATURATION: "charts.spo2",
};

function getTypeLabel(
  type: string,
  valueMode: "raw" | "bmi",
  t: (key: string) => string,
): string {
  if (type === "WEIGHT" && valueMode === "bmi") {
    return "BMI";
  }
  const key = BASE_TYPE_LABEL_KEYS[type];
  return key ? t(key) : type;
}

const BERLIN_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function toBerlinDayKey(value: string): string {
  const parts = BERLIN_DAY_FORMATTER.formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Could not derive day key for chart");
  }

  return `${year}-${month}-${day}`;
}

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

/**
 * v1.4.16 B1a — personal-baseline helper.
 *
 * Computes the median (50th-percentile) value of a daily-aggregated
 * series, capped at the most-recent 90 daily points (Apple Health uses
 * the rolling-90-day window for "your normal" framing). Returns `null`
 * when fewer than 5 points exist — a baseline drawn off 1-2 readings is
 * misleading; surface nothing instead.
 *
 * Pure & deterministic so the unit test pins exact medians.
 */
export function computePersonalBaseline(
  data: Array<{ value: number }>,
  windowPoints = 90,
): number | null {
  if (data.length < 5) return null;
  const recent = data.slice(-windowPoints);
  const sorted = recent.map((d) => d.value).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function buildTrendSeriesByTime(data: Array<{ date: Date; value: number }>): {
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

export function HealthChart({
  types,
  title,
  colors = ["#bd93f9", "#ff79c6", "#8be9fd"],
  unit,
  yAxisUnit,
  valueMode = "raw",
  yAxisWidth = 76,
  showYAxisUnit = true,
  valueBands,
  targetZones,
  mini = false,
  windowOverride,
  compareBaseline = "none",
}: HealthChartProps) {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();
  // v1.4.16 B5c: when a windowOverride is supplied, seed the range
  // state from it so the chart pins to that window. Mini mode also
  // hides the range tabs, so the user can't change it.
  const initialRangePoints = windowOverride
    ? resolveMiniRangePoints(windowOverride)
    : 30;
  const [rangePoints, setRangePoints] = useState(initialRangePoints);
  const [showMA, setShowMA] = useState(false);
  const [showTrend, setShowTrend] = useState(false);
  const [showBands, setShowBands] = useState(false);
  const maToggleId = useId();
  const trendToggleId = useId();
  const bandsToggleId = useId();

  const bmiDivisor =
    valueMode === "bmi" && user?.heightCm ? (user.heightCm / 100) ** 2 : null;

  const { data, isLoading } = useQuery({
    queryKey: [
      "chart-data",
      types.join(","),
      valueMode,
      bmiDivisor ?? "no-bmi",
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("sortBy", "measuredAt");
      params.set("sortDir", "asc");

      const dailyAggregates = new Map<
        string,
        {
          timestamp: number;
          values: Record<string, { sum: number; count: number }>;
        }
      >();

      async function fetchAllMeasurementsByType(type: string) {
        const pageSize = 500;
        let offset = 0;

        while (true) {
          const typeParams = new URLSearchParams(params);
          typeParams.set("type", type);
          typeParams.set("limit", String(pageSize));
          typeParams.set("offset", String(offset));

          const res = await fetch(`/api/measurements?${typeParams}`);
          if (!res.ok) break;

          const json = await res.json();
          const page = (json.data?.measurements ?? []) as MeasurementApiRow[];
          const total = Number(json.data?.meta?.total ?? page.length);

          for (const measurement of page) {
            const rawValue = measurement.value;
            const value =
              valueMode === "bmi"
                ? bmiDivisor
                  ? rawValue / bmiDivisor
                  : null
                : rawValue;

            if (value == null || !Number.isFinite(value)) {
              continue;
            }

            const dayKey = toBerlinDayKey(measurement.measuredAt);
            const bucket = dailyAggregates.get(dayKey) ?? {
              timestamp: dayKeyToTimestamp(dayKey),
              values: {},
            };
            const current = bucket.values[type] ?? { sum: 0, count: 0 };
            current.sum += value;
            current.count += 1;
            bucket.values[type] = current;
            dailyAggregates.set(dayKey, bucket);
          }

          offset += page.length;
          if (page.length === 0 || offset >= total || page.length < pageSize) {
            break;
          }
        }
      }

      await Promise.all(types.map(fetchAllMeasurementsByType));

      const allData: ChartDataPoint[] = Array.from(dailyAggregates.values())
        .map((bucket) => {
          const point: ChartDataPoint = {
            date: formatDateShort(new Date(bucket.timestamp)),
            timestamp: bucket.timestamp,
          };

          for (const [type, stats] of Object.entries(bucket.values)) {
            point[type] = stats.sum / stats.count;
          }

          return point;
        })
        .sort((a, b) => a.timestamp - b.timestamp);

      return allData;
    },
    enabled: isAuthenticated,
  });

  const chartData = useMemo(() => {
    if (!data?.length) return data;

    const sliced = rangePoints > 0 ? data.slice(-rangePoints) : [...data];

    // v1.4.6: aggregate to weekly / monthly when the visible range is
    // long enough that drawing every daily point would clutter the
    // chart. Picking the bucket from the *visible* range, not the
    // total dataset, so a "30 days" toggle still shows daily even on
    // a five-year-old account.
    const rangeDays =
      sliced.length < 2
        ? 0
        : Math.round(
            (sliced[sliced.length - 1].timestamp - sliced[0].timestamp) /
              (24 * 60 * 60 * 1000),
          );
    const bucketType = pickBucket(rangeDays);

    const bucketed =
      bucketType === "day"
        ? sliced
        : bucketTimeSeries(
            sliced.map((p) => ({
              timestamp: p.timestamp,
              values: Object.fromEntries(
                types.map((type) => [type, p[type] as number | undefined]),
              ),
            })),
            { bucket: bucketType },
          ).points.map<ChartDataPoint>((point) => {
            const date = new Date(point.timestamp);
            const out: ChartDataPoint = {
              date: formatDateShort(date),
              timestamp: point.timestamp,
            };
            for (const [type, value] of Object.entries(point.values)) {
              out[type] = value;
            }
            return out;
          });

    const enriched: ChartDataPoint[] = bucketed.map((d, index) => ({
      ...d,
      pointIndex: index,
    }));

    if (showMA) {
      for (const type of types) {
        const typeData = enriched
          .filter((d) => d[type] !== undefined)
          .map((d) => ({
            date: new Date(d.timestamp),
            value: d[type] as number,
          }));

        if (typeData.length >= 2) {
          const ma = movingAverageByPoints(typeData, 7);
          for (const point of ma) {
            const pointTimestamp = point.date.getTime();
            const existing = enriched.find(
              (d) => d.timestamp === pointTimestamp,
            );
            if (existing) {
              existing[`${type}_ma`] = point.value;
            }
          }
        }
      }
    }

    if (showTrend) {
      for (const type of types) {
        const typeData = enriched
          .filter((d) => d[type] !== undefined)
          .map((d) => ({
            date: new Date(d.timestamp),
            value: d[type] as number,
          }));

        if (typeData.length >= 2) {
          const trend = buildTrendSeriesByTime(typeData);
          if (trend) {
            for (const point of trend.points) {
              const pointTimestamp = point.date.getTime();
              const existing = enriched.find(
                (d) => d.timestamp === pointTimestamp,
              );
              if (existing) {
                existing[`${type}_trend`] = point.value;
              }
            }
          }
        }
      }
    }

    return enriched;
  }, [data, rangePoints, showMA, showTrend, types]);

  // v1.4.16 phase B8 — comparison overlay.
  //
  // When the toggle is active, derive a prior-period series from the
  // ALREADY-FETCHED daily aggregates (`data`), shift the timestamps
  // forward by 30 / 365 days, and stamp the values into the visible
  // `chartData` under `${type}_compare` keys. The Recharts <Line>
  // children below render those keys as dimmed dashed lines beneath
  // the current series, and the tooltip picks them up so the user can
  // read both numbers + the delta in one place.
  //
  // The merge is point-equal-day: a prior-period point only paints
  // when its shifted timestamp lands on a visible day. Sparse prior
  // periods are silently dropped (the chart's empty caption surfaces
  // "Comparison unavailable — no data from last month yet" via the
  // hasComparisonData flag below).
  const chartDataWithCompare = useMemo(() => {
    if (!chartData || compareBaseline === "none") return chartData;
    if (!data?.length) return chartData;

    const shifted = shiftDailySeriesForward(
      data.map((row) => ({
        timestamp: row.timestamp,
        values: Object.fromEntries(
          types.map((type) => [type, row[type] as number | undefined]),
        ),
      })),
      compareBaseline,
    );

    // Index shifted rows by the same day-key the chart already uses.
    const shiftedByDay = new Map<string, Record<string, number>>();
    for (const row of shifted) {
      const dayKey = formatDateShort(new Date(row.timestamp));
      const slot = shiftedByDay.get(dayKey) ?? {};
      for (const [type, value] of Object.entries(row.values)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          slot[type] = value;
        }
      }
      shiftedByDay.set(dayKey, slot);
    }

    return chartData.map((point) => {
      const compareValues = shiftedByDay.get(point.date);
      if (!compareValues) return point;
      const merged: ChartDataPoint = { ...point };
      for (const type of types) {
        const v = compareValues[type];
        if (typeof v === "number" && Number.isFinite(v)) {
          merged[`${type}_compare`] = v;
        }
      }
      return merged;
    });
  }, [chartData, compareBaseline, data, types]);

  /**
   * v1.4.16 phase B8 — true when at least one visible day has a prior-
   * period value to overlay. Drives the "Comparison unavailable" caption
   * fallback in the chart header. Empty input → false → caption shows;
   * a partial overlay (some days have prior data, some don't) is treated
   * as "available" so we don't surprise the user with a missing caption
   * when they can clearly see SOME dimmed history.
   */
  const hasComparisonData = useMemo(() => {
    if (compareBaseline === "none" || !chartDataWithCompare) return false;
    return chartDataWithCompare.some((point) =>
      types.some(
        (type) =>
          typeof point[`${type}_compare`] === "number" &&
          Number.isFinite(point[`${type}_compare`] as number),
      ),
    );
  }, [chartDataWithCompare, compareBaseline, types]);

  const activeBucket: ChartBucketType = useMemo(() => {
    if (!data?.length) return "day";
    const sliced = rangePoints > 0 ? data.slice(-rangePoints) : data;
    if (sliced.length < 2) return "day";
    const rangeDays = Math.round(
      (sliced[sliced.length - 1].timestamp - sliced[0].timestamp) /
        (24 * 60 * 60 * 1000),
    );
    return pickBucket(rangeDays);
  }, [data, rangePoints]);

  const yDomain = useMemo<[number, number] | undefined>(() => {
    if (!chartDataWithCompare?.length) return undefined;

    const keys = [...types];
    if (showMA) keys.push(...types.map((type) => `${type}_ma`));
    if (showTrend) keys.push(...types.map((type) => `${type}_trend`));
    // v1.4.16 phase B8 — extend the y-domain to fit the prior-period
    // overlay. Without this the dimmed line can clip outside the
    // visible range when last-month / last-year had a different scale.
    if (compareBaseline !== "none") {
      keys.push(...types.map((type) => `${type}_compare`));
    }

    const values = chartDataWithCompare
      .flatMap((point) => keys.map((key) => point[key]))
      .filter((value): value is number => typeof value === "number")
      .filter((value) => Number.isFinite(value));

    if (!values.length) return undefined;

    const min = Math.min(...values);
    const max = Math.max(...values);

    if (min === max) {
      const delta = Math.max(Math.abs(min) * 0.05, 1);
      return [min - delta, max + delta * 1.35];
    }

    const span = max - min;
    const paddingBottom = Math.max(span * 0.08, 0.5);
    const paddingTop = Math.max(span * 0.16, 1);
    return [min - paddingBottom, max + paddingTop];
  }, [chartDataWithCompare, compareBaseline, showMA, showTrend, types]);

  const visibleBands = useMemo(() => {
    if (!showBands || !valueBands?.length || !yDomain) return [];

    const [domainMin, domainMax] = yDomain;
    const span = domainMax - domainMin;
    if (!Number.isFinite(span) || span <= 0) return [];

    return valueBands
      .map((band, index) => {
        const low = Math.max(Math.min(band.min, band.max), domainMin);
        const high = Math.min(Math.max(band.min, band.max), domainMax);
        if (high <= low) return null;

        const topPct = ((domainMax - high) / span) * 100;
        const heightPct = ((high - low) / span) * 100;

        return {
          key: `${band.min}-${band.max}-${index}`,
          topPct,
          heightPct,
          color: band.color,
          opacity: band.opacity ?? 0.2,
          strokeOpacity: band.strokeOpacity ?? 0.35,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          key: string;
          topPct: number;
          heightPct: number;
          color: string;
          opacity: number;
          strokeOpacity: number;
        } => entry !== null && entry.heightPct > 0,
      );
  }, [showBands, valueBands, yDomain]);

  const visibleTargetZones = useMemo<VisibleTargetZone[]>(() => {
    if (!showBands || !targetZones?.length || !yDomain) return [];
    const [domainMin, domainMax] = yDomain;
    const span = domainMax - domainMin;
    if (!Number.isFinite(span) || span <= 0) return [];

    const zones: Array<{
      key: string;
      low: number;
      high: number;
      topPct: number;
      heightPct: number;
      color: string;
      opacity: number;
      label: string | undefined;
      textColor: string | undefined;
      lineOpacity: number;
    }> = [];

    for (const [index, zone] of targetZones.entries()) {
      const low = Math.max(Math.min(zone.min, zone.max), domainMin);
      const high = Math.min(Math.max(zone.min, zone.max), domainMax);
      if (high <= low) continue;
      const topPct = ((domainMax - high) / span) * 100;
      const heightPct = ((high - low) / span) * 100;

      zones.push({
        key: `${zone.min}-${zone.max}-${index}`,
        low,
        high,
        topPct,
        heightPct,
        color: zone.color,
        opacity: zone.opacity ?? 0.3,
        label: zone.label ?? undefined,
        textColor: zone.textColor ?? undefined,
        lineOpacity: zone.lineOpacity ?? 0.42,
      });
    }

    return zones;
  }, [showBands, targetZones, yDomain]);

  const formatAxisValue = (value: number) => fmt.integer(value);

  const formatTooltipValue = (value: number) => fmt.number(value, 1);

  const trendInfo = useMemo(() => {
    if (!showTrend || !chartData?.length) return [];

    const formatSigned = (value: number) => {
      const formatted = fmt.number(Math.abs(value), 1);
      return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}`;
    };

    return types
      .map((type) => {
        const series = chartData.filter(
          (point) =>
            typeof point[type] === "number" &&
            typeof point[`${type}_trend`] === "number",
        );
        if (series.length < 2) return null;

        const first = series[0];
        const last = series[series.length - 1];
        const days = (last.timestamp - first.timestamp) / 86400000;
        if (!Number.isFinite(days) || days <= 0) return null;

        const rawValues = series.map((point) => point[type] as number);
        const trendValues = series.map(
          (point) => point[`${type}_trend`] as number,
        );

        // v1.4.16 Fix A8b — delegate to the pure helper so the long-
        // window split-half delta gets a unit-test that doesn't depend
        // on Recharts. See `src/lib/analytics/window-trend.ts`.
        const computed = computeWindowTrend({
          rawValues,
          trendValues,
          windowDays: days,
        });
        if (!computed) return null;

        const { weeklyDelta, splitHalfDelta } = computed;
        const base = rawValues[0];
        const weeklyPct =
          Math.abs(base) > Number.EPSILON
            ? (weeklyDelta / Math.abs(base)) * 100
            : null;
        const unitSuffix = unit ? ` ${unit}` : "";

        // v1.4.16 Fix A8b: when the visible window is long (e.g. "All"
        // on a multi-year account), the per-week delta becomes vanishingly
        // small and rounds to ±0.0 in the formatter — Marc's complaint
        // "Wenn ich alle anklicke, dann wird einfach Null Veränderung
        // angezeigt" was exactly this: a slope of ~0.5 kg/year prints
        // as "+0.0 kg/week" and the user reads it as "no change". For
        // windows ≥ SPLIT_HALF_THRESHOLD_DAYS we additionally surface
        // the first-half vs. second-half mean delta — a single,
        // meaningful number that cannot round to zero unless the metric
        // truly didn't move.
        let totalDeltaSegment = "";
        if (days >= SPLIT_HALF_THRESHOLD_DAYS && splitHalfDelta !== null) {
          const meanFirst =
            rawValues
              .slice(0, Math.floor(rawValues.length / 2))
              .reduce((sum, value) => sum + value, 0) /
            Math.max(1, Math.floor(rawValues.length / 2));
          const totalDeltaPct =
            Math.abs(meanFirst) > Number.EPSILON
              ? (splitHalfDelta / Math.abs(meanFirst)) * 100
              : null;
          totalDeltaSegment = ` · ${t(
            "charts.totalDelta",
          )} ${formatSigned(splitHalfDelta)}${unitSuffix}${
            totalDeltaPct != null ? ` (${formatSigned(totalDeltaPct)} %)` : ""
          }`;
        }

        return `${getTypeLabel(type, valueMode, t)}: ${formatSigned(
          weeklyDelta,
        )}${unitSuffix}${t("charts.perWeek")}${
          weeklyPct != null
            ? ` (${formatSigned(weeklyPct)} %${t("charts.perWeek")})`
            : ""
        }${totalDeltaSegment}`;
      })
      .filter((entry): entry is string => entry !== null);
  }, [chartData, showTrend, types, unit, valueMode, t, fmt]);

  // v1.4.16 B1a — personal baseline (90-day rolling median) per type.
  // Painted as a faint dashed reference line labelled "Your normal" so
  // the user can read each point against their own baseline, not an
  // absolute value the chart axis happens to render.
  const personalBaselines = useMemo(() => {
    if (!chartData?.length) return new Map<string, number>();
    const map = new Map<string, number>();
    for (const type of types) {
      const series = chartData
        .filter((d) => typeof d[type] === "number")
        .map((d) => ({ value: d[type] as number }));
      const baseline = computePersonalBaseline(series, 90);
      if (baseline !== null) map.set(type, baseline);
    }
    return map;
  }, [chartData, types]);

  if (!isLoading && !data?.length) return null;

  const maxPointIndex = Math.max(0, (chartData?.length ?? 1) - 1);
  const showContextDetails = showMA || showTrend || showBands;
  const animationsEnabled = !prefersReducedMotion();

  // v1.4.16 B5c — mini mode tunes padding + margins so the chart fits
  // inside the rationale card without overwhelming the surrounding
  // rows. Range tabs + toggle row are suppressed entirely; the chart
  // pins to `windowOverride` (or the default 30pt) instead.
  const containerClass = mini
    ? "bg-card border-border rounded-md border p-2"
    : "bg-card border-border rounded-xl border p-4 md:p-6";
  const chartHeightClass = mini ? "h-[140px]" : "h-[240px]";

  return (
    <div className={containerClass} data-slot={mini ? "chart-mini" : undefined}>
      {!mini && (
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            {activeBucket !== "day" && (
              <span className="bg-muted/40 text-muted-foreground rounded-md px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">
                {t(
                  activeBucket === "week"
                    ? "charts.bucketWeekly"
                    : "charts.bucketMonthly",
                )}
              </span>
            )}
            {/* v1.4.16 phase B8 — comparison caption. Inline with the
                bucket-aggregation chip so the user reads "what window
                am I looking at" + "what comparison is overlaid" in one
                glance. The "Comparison unavailable" fallback uses
                neutral muted styling so it doesn't read as an error. */}
            {compareBaseline !== "none" && hasComparisonData && (
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
            {compareBaseline !== "none" && !hasComparisonData && (
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
          <div className="flex flex-wrap justify-end gap-1">
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
        </div>
      )}

      {mini && (
        <div className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wider uppercase">
          {title}
        </div>
      )}

      {!mini && (
        <div className="text-muted-foreground mb-3 flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <Switch
              id={maToggleId}
              checked={showMA}
              onCheckedChange={setShowMA}
            />
            <Label htmlFor={maToggleId} className="cursor-pointer text-xs">
              {t("charts.movingAverage7d")}
            </Label>
          </div>
          <div className="flex items-center gap-1.5">
            <Switch
              id={trendToggleId}
              checked={showTrend}
              onCheckedChange={setShowTrend}
            />
            <Label htmlFor={trendToggleId} className="cursor-pointer text-xs">
              {t("charts.trend")}
            </Label>
          </div>
          {valueBands?.length || targetZones?.length ? (
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
          ) : null}
        </div>
      )}

      {!mini && showTrend && trendInfo.length > 0 ? (
        <div className="text-muted-foreground mb-3 flex flex-wrap gap-3 text-xs">
          {trendInfo.map((info) => (
            <span key={info}>{info}</span>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : !chartData?.length ? null : (chartData?.length ?? 0) < 3 ? (
        // v1.4.16 B1a — sparse-data placeholder. <3 daily points is too
        // few to render a meaningful trend; paint a friendly hint
        // instead so the dashboard doesn't look broken.
        <ChartEmptyState
          title={t("charts.emptyStateTitle")}
          description={t("charts.emptyStateDescription")}
        />
      ) : (
        <div className={`relative ${chartHeightClass}`}>
          {visibleBands.length > 0 ? (
            <div
              className="pointer-events-none absolute"
              style={{
                left: `${8 + yAxisWidth}px`,
                right: "18px",
                top: "10px",
                bottom: "32px",
                zIndex: 0,
              }}
            >
              {visibleBands.map((band) => (
                <div
                  key={band.key}
                  className="absolute right-0 left-0"
                  style={{
                    top: `${band.topPct}%`,
                    height: `${band.heightPct}%`,
                    backgroundColor: band.color,
                    opacity: band.opacity,
                    borderTop: `1px solid ${band.color}`,
                    borderBottom: `1px solid ${band.color}`,
                  }}
                />
              ))}
            </div>
          ) : null}

          {/* v1.4.18 — gradient fill removed per Marc's feedback.
              The clean line is the chart; no painted background under
              it. */}
          <div className="relative z-10 h-full touch-pan-y">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={chartDataWithCompare ?? chartData}
                margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  opacity={0.5}
                />
                <XAxis
                  type="number"
                  dataKey="pointIndex"
                  domain={[0, maxPointIndex]}
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) =>
                    formatDateShort(
                      new Date(
                        chartData?.[Math.round(value)]?.timestamp ?? Date.now(),
                      ),
                      true,
                    )
                  }
                  interval="preserveStartEnd"
                  padding={{ left: 10, right: 10 }}
                  tickMargin={10}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={yAxisWidth}
                  tickMargin={10}
                  domain={yDomain}
                  tickFormatter={(value) =>
                    typeof value === "number"
                      ? formatAxisValue(Math.round(value))
                      : String(value)
                  }
                  unit={
                    showYAxisUnit && (yAxisUnit ?? unit)
                      ? ` ${yAxisUnit ?? unit}`
                      : undefined
                  }
                />
                {visibleTargetZones.map((zone) => (
                  <ReferenceArea
                    key={`${zone.key}-fill`}
                    x1={0}
                    x2={maxPointIndex}
                    y1={zone.low}
                    y2={zone.high}
                    fill={zone.color}
                    fillOpacity={zone.opacity}
                    strokeOpacity={0}
                    ifOverflow="discard"
                  />
                ))}
                {visibleTargetZones.map((zone) => (
                  <ReferenceLine
                    key={`${zone.key}-low`}
                    y={zone.low}
                    stroke={zone.color}
                    strokeDasharray="6 4"
                    strokeWidth={1.75}
                    strokeOpacity={zone.lineOpacity}
                  />
                ))}
                {visibleTargetZones.map((zone) => (
                  <ReferenceLine
                    key={`${zone.key}-high`}
                    y={zone.high}
                    stroke={zone.color}
                    strokeDasharray="6 4"
                    strokeWidth={1.75}
                    strokeOpacity={zone.lineOpacity}
                    label={
                      zone.label
                        ? {
                            value: zone.label,
                            position: "right",
                            fill: zone.textColor ?? zone.color,
                            fontSize: 10,
                          }
                        : undefined
                    }
                  />
                ))}
                {/* v1.4.18 — personal-baseline reference line is now
                    opt-in via the Trend toggle. Marc rejected the
                    always-on dashed mean line; it now only paints when
                    the user actively shows the trend overlay (matching
                    his rule: "only when a trend is being displayed").
                    90-day rolling median per type, faint dashed line,
                    only the first type gets the inline label so
                    multi-type charts don't paint duplicate labels. */}
                {showTrend &&
                  types.map((type, i) => {
                    const baseline = personalBaselines.get(type);
                    if (baseline == null) return null;
                    return (
                      <ReferenceLine
                        key={`baseline-${type}`}
                        y={baseline}
                        stroke={colors[i % colors.length]}
                        strokeDasharray="2 4"
                        strokeOpacity={0.4}
                        strokeWidth={1}
                        ifOverflow="discard"
                        label={
                          i === 0
                            ? {
                                value: t("charts.personalBaseline"),
                                position: "insideTopLeft",
                                fill: "var(--muted-foreground)",
                                fontSize: 10,
                                opacity: 0.7,
                              }
                            : undefined
                        }
                      />
                    );
                  })}
                <Tooltip
                  filterNull={false}
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
                    // Build a quick lookup of compare values for this
                    // hover-day so the current-period row can attach
                    // a "vs. last month / year" delta inline. Same-day
                    // current ↔ compare values come from the SAME
                    // payload object.
                    const hoverPoint = payload[0]?.payload as
                      | ChartDataPoint
                      | undefined;
                    for (const item of payload) {
                      if (typeof item.value !== "number") continue;
                      const dataKey = String(item.dataKey ?? "");
                      // Skip auxiliary lines (`*_ma`, `*_trend`,
                      // `*_compare`) — the comparison value is rendered
                      // inline as the delta on the current-period row,
                      // and ma / trend already appear as dashed overlays
                      // on the chart itself.
                      if (
                        dataKey.endsWith("_ma") ||
                        dataKey.endsWith("_trend") ||
                        dataKey.endsWith("_compare")
                      )
                        continue;
                      const baseline = personalBaselines.get(dataKey);
                      let delta: string | undefined;
                      // v1.4.16 phase B8 — prefer the comparison delta
                      // ("Δ −7 vs. last month") over the personal
                      // baseline delta when comparison is active and we
                      // have a prior value for this day. Otherwise fall
                      // back to the existing baseline-delta path.
                      const compareValue =
                        compareBaseline !== "none" && hoverPoint
                          ? (hoverPoint[`${dataKey}_compare`] as
                              | number
                              | undefined)
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
                          const formatted = `${sign}${fmt.number(
                            Math.abs(diff),
                            1,
                          )}${unit ? ` ${unit}` : ""}`;
                          delta = t(
                            compareBaseline === "lastMonth"
                              ? "comparison.deltaVs.lastMonth"
                              : "comparison.deltaVs.lastYear",
                          ).replace("{delta}", formatted);
                        }
                      } else if (baseline != null) {
                        const diff = item.value - baseline;
                        if (Math.abs(diff) < 0.05) {
                          delta = t("charts.deltaUnchanged");
                        } else {
                          const sign = diff > 0 ? "+" : "−";
                          const formatted = `${sign}${fmt.number(
                            Math.abs(diff),
                            1,
                          )}${unit ? ` ${unit}` : ""}`;
                          delta = t("charts.deltaVsBaseline").replace(
                            "{delta}",
                            formatted,
                          );
                        }
                      }
                      rows.push({
                        name: item.name ?? dataKey,
                        value: `${formatTooltipValue(item.value)}${
                          unit ? ` ${unit}` : ""
                        }`,
                        color: item.color ?? "var(--dracula-purple)",
                        delta,
                      });
                      // v1.4.16 phase B8 — also surface the prior-period
                      // value as its own row so the user reads both
                      // numbers (current AND last-month / last-year)
                      // alongside the delta.
                      if (
                        compareBaseline !== "none" &&
                        typeof compareValue === "number" &&
                        Number.isFinite(compareValue)
                      ) {
                        rows.push({
                          name: `${item.name ?? dataKey} · ${t(
                            "comparison.tooltipPrior",
                          )}`,
                          value: `${formatTooltipValue(compareValue)}${
                            unit ? ` ${unit}` : ""
                          }`,
                          color: item.color ?? "var(--dracula-purple)",
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
                {showContextDetails && (
                  <Legend
                    wrapperStyle={{
                      fontSize: "0.875rem",
                      fontFamily: "inherit",
                      fontWeight: "normal",
                    }}
                  />
                )}
                {/* v1.4.18 — gradient Area removed; only the clean
                    line below paints the metric. */}
                {types.map((type, i) => (
                  <Line
                    key={type}
                    type="monotone"
                    dataKey={type}
                    name={getTypeLabel(type, valueMode, t)}
                    stroke={colors[i % colors.length]}
                    strokeWidth={2}
                    dot={{ r: 3, fill: colors[i % colors.length] }}
                    activeDot={{ r: 5 }}
                    connectNulls
                    isAnimationActive={animationsEnabled}
                    animationDuration={animationsEnabled ? 600 : 0}
                    animationEasing="ease-out"
                  />
                ))}
                {showMA &&
                  types.map((type, i) => (
                    <Line
                      key={`${type}_ma`}
                      type="monotone"
                      dataKey={`${type}_ma`}
                      name={`${getTypeLabel(type, valueMode, t)} (${t("charts.movingAverage7d")})`}
                      stroke={colors[i % colors.length]}
                      strokeWidth={1.5}
                      strokeDasharray="5 5"
                      strokeOpacity={0.7}
                      dot={false}
                      connectNulls
                    />
                  ))}
                {showTrend &&
                  types.map((type) => (
                    <Line
                      key={`${type}_trend`}
                      type="linear"
                      dataKey={`${type}_trend`}
                      name={`${getTypeLabel(type, valueMode, t)} (${t("charts.trend")})`}
                      stroke="var(--muted-foreground)"
                      strokeWidth={1}
                      strokeDasharray="8 4"
                      dot={false}
                      connectNulls
                    />
                  ))}
                {/* v1.4.16 phase B8 — comparison overlay.
                    A dimmed dashed line per type for the prior period
                    (lastMonth / lastYear), painted BENEATH the current
                    series via Recharts' source-order layering. Same
                    base colour as the current line but with reduced
                    stroke opacity (45%) and a thinner stroke (1.25)
                    so the user reads the current line first and the
                    overlay as orientation. */}
                {compareBaseline !== "none" &&
                  hasComparisonData &&
                  types.map((type, i) => (
                    <Line
                      key={`${type}_compare`}
                      type="monotone"
                      dataKey={`${type}_compare`}
                      name={`${getTypeLabel(type, valueMode, t)} (${t(
                        compareBaseline === "lastMonth"
                          ? "comparison.captionLastMonth"
                          : "comparison.captionLastYear",
                      )})`}
                      stroke={colors[i % colors.length]}
                      strokeWidth={1.25}
                      strokeDasharray="4 3"
                      strokeOpacity={0.45}
                      dot={false}
                      connectNulls
                      isAnimationActive={animationsEnabled}
                      animationDuration={animationsEnabled ? 600 : 0}
                      animationEasing="ease-out"
                      legendType="none"
                      data-slot={`chart-compare-line-${type}`}
                    />
                  ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
