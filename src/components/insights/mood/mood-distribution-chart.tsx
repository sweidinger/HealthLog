"use client";

import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useTranslations } from "@/lib/i18n/context";
import { moodLabelKeyForScore } from "@/lib/mood/labels";

/**
 * v1.8.5 — mood distribution (share of days per level).
 *
 * One bar per discrete mood level 1..5, coloured by the same band map
 * as the heatmap + line chart. Counts are days (daily means rounded to
 * the nearest level) so multi-entry days never over-weight the
 * histogram — consistent with the rest of the surface's daily-mean
 * convention.
 */

export interface MoodDistributionRow {
  score: number;
  count: number;
}

const BAR_COLOR_BY_SCORE: Record<number, string> = {
  1: "var(--dracula-red)",
  2: "var(--dracula-orange)",
  3: "var(--dracula-yellow)",
  4: "var(--dracula-green)",
  5: "var(--dracula-green)",
};

export function MoodDistributionChart({
  distribution,
}: {
  distribution: MoodDistributionRow[];
}) {
  const { t } = useTranslations();

  const data = distribution.map((row) => {
    const labelKey = moodLabelKeyForScore(row.score);
    return {
      score: row.score,
      count: row.count,
      label: labelKey ? t(labelKey) : String(row.score),
    };
  });

  return (
    <div className="aspect-[3/2] min-h-[180px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "var(--dracula-fg)" }}
            stroke="var(--dracula-comment)"
            interval={0}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "var(--dracula-fg)" }}
            stroke="var(--dracula-comment)"
            width={28}
          />
          <Tooltip
            cursor={{ fill: "var(--secondary)", opacity: 0.4 }}
            contentStyle={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              fontSize: "0.75rem",
            }}
            itemStyle={{ color: "var(--dracula-fg)" }}
            labelStyle={{ color: "var(--dracula-fg)" }}
            formatter={(value) =>
              [
                `${value ?? 0} ${t("insights.mood.distributionDaysUnit")}`,
                t("insights.mood.distributionTitle"),
              ] as [string, string]
            }
          />
          <Bar dataKey="count" radius={[3, 3, 0, 0]}>
            {data.map((row) => (
              <Cell
                key={row.score}
                fill={BAR_COLOR_BY_SCORE[row.score] ?? "var(--dracula-purple)"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
