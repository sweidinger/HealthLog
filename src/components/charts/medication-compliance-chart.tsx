"use client";

/**
 * Dashboard medication-compliance chart.
 *
 * Wired to the `medications` toggle in Settings → Dashboard. Up to v1.4.14
 * the toggle existed but the dashboard slot only rendered a static
 * placeholder (an icon + the section title), so flipping it on did nothing
 * visible. This wrapper shows daily compliance % across all of the user's
 * scheduled medications for the last N days, matching the same visual
 * pattern the other dashboard charts use (Card surface, Dracula tokens,
 * range chips in the header, ReferenceLine target at 80 %).
 *
 * Data source: `GET /api/medications/intake?scope=compliance&days=N`
 * already returns `{ date, scheduled, taken }[]`. We aggregate to
 * `taken / scheduled * 100` per day; days without any scheduled doses
 * are skipped (compliance is undefined for a day with no expected
 * intakes — drawing a 0 % point on those would mis-represent the data).
 *
 * IMPORTANT: keep the recharts primitives as static imports inside
 * this wrapper. Phase 4 visual-verify (v1.4.14) proved that wrapping
 * individual primitives in `next/dynamic` breaks Recharts'
 * `findAllByType` reconciliation; the dashboard's `next/dynamic` for
 * the wrapper itself stays intact.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import { Loader2, Pill } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { formatDateShort } from "@/lib/format";

interface DailyCompliancePoint {
  /** Berlin calendar day, "YYYY-MM-DD". */
  date: string;
  scheduled: number;
  taken: number;
}

interface ChartPoint {
  date: string;
  rate: number;
  timestamp: number;
}

const COLOR_LINE = "var(--dracula-purple)";
const COLOR_TARGET = "var(--dracula-green)";

/** Days for the range buttons. v1.4.15 keeps this in sync with the
 *  health-chart range presets so the dashboard reads consistently. */
const RANGE_DAYS = [7, 30, 90] as const;
type RangeDays = (typeof RANGE_DAYS)[number];

/**
 * Aggregate daily-compliance points from the `/api/medications/intake`
 * compliance scope into chart-ready rows. Days without any expected
 * intakes are skipped — compliance is undefined when nothing was due.
 *
 * Pure & deterministic so the unit test pins exact rates.
 */
export function aggregateMedicationCompliance(
  points: DailyCompliancePoint[],
): ChartPoint[] {
  return points
    .filter((p) => p.scheduled > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((p) => {
      const [y, m, d] = p.date.split("-").map(Number);
      // Anchor the timestamp at noon UTC of the Berlin day so a tooltip
      // and tick formatter never disagree across DST boundaries.
      const ts = Date.UTC(y, m - 1, d, 12);
      const rate = Math.min(100, Math.round((p.taken / p.scheduled) * 100));
      return {
        date: formatDateShort(new Date(ts), true),
        rate,
        timestamp: ts,
      };
    });
}

interface MedicationComplianceChartProps {
  /** Override the visible label, primarily for tests. */
  title?: string;
}

export function MedicationComplianceChart({
  title,
}: MedicationComplianceChartProps) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [days, setDays] = useState<RangeDays>(30);

  const { data, isLoading } = useQuery({
    queryKey: ["medication-compliance-chart", days],
    queryFn: async (): Promise<DailyCompliancePoint[]> => {
      const res = await fetch(
        `/api/medications/intake?scope=compliance&days=${days}`,
      );
      if (!res.ok) throw new Error("failed to fetch medication compliance");
      const json = await res.json();
      return json.data as DailyCompliancePoint[];
    },
    enabled: isAuthenticated,
  });

  const chartData = useMemo(
    () => (data ? aggregateMedicationCompliance(data) : []),
    [data],
  );

  const displayTitle = title ?? t("dashboard.medications");
  const yAxisFormatter = (value: number) => `${fmt.integer(value)} %`;

  // Empty-state guard: if the user has zero scheduled doses across the
  // whole window we render the title + a "no data" hint, mirroring how
  // the other charts handle the empty case (HealthChart returns null
  // entirely; here we keep the surface visible because the toggle is
  // explicit user opt-in — silence would feel like a bug).
  const hasData = chartData.length > 0;

  return (
    <div
      className="bg-card border-border rounded-xl border p-4 md:p-6"
      data-slot="medication-compliance-chart"
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Pill className="text-muted-foreground h-4 w-4" />
          <h3 className="text-sm font-semibold">{displayTitle}</h3>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {RANGE_DAYS.map((r) => (
            <Button
              key={r}
              variant={days === r ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setDays(r)}
            >
              {r}T
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : !hasData ? (
        <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
          {t("charts.noData")}
        </div>
      ) : (
        <div className="h-[240px] touch-pan-y">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--border)"
                opacity={0.5}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={yAxisFormatter}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: "0.5rem",
                  fontSize: "0.875rem",
                }}
                formatter={(value) =>
                  typeof value === "number"
                    ? [`${fmt.integer(value)} %`, t("dashboard.compliance7d")]
                    : value
                }
                labelFormatter={(_label, payload) =>
                  payload?.[0]?.payload?.timestamp
                    ? formatDateShort(
                        new Date(payload[0].payload.timestamp as number),
                        true,
                      )
                    : ""
                }
              />
              <ReferenceLine
                y={80}
                stroke={COLOR_TARGET}
                strokeDasharray="5 5"
                strokeOpacity={0.7}
              />
              <Line
                type="monotone"
                dataKey="rate"
                stroke={COLOR_LINE}
                strokeWidth={2}
                dot={{ r: 2, fill: COLOR_LINE }}
                activeDot={{ r: 4 }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
