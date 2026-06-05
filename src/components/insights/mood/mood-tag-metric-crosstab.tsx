"use client";

import { useTranslations } from "@/lib/i18n/context";
import { moodTagIcon } from "@/components/mood/mood-tag-icons";
import { cn } from "@/lib/utils";
import type { MoodInfluenceConfidence } from "./mood-tag-influence";

/**
 * v1.12.0 — tag × health-metric crosstab card.
 *
 * Daylio's "Activities & Mood" board, extended from mood to a health
 * METRIC: for each structured mood tag, a metric's mean on tag-present vs
 * tag-absent days, the delta, and a confidence chip. The math is
 * pre-computed in `mood-aggregates.ts` (`computeTagMetricCrosstab`) — the
 * same Welch t-test + day floors + Benjamini-Hochberg FDR the rest of the
 * relations surface uses; only FDR-surviving rows reach here. Observational
 * only: the generic "associations, not causes" caveat lives once in the
 * page-level Insights footer, so this card no longer repeats it.
 */

export type MoodCrosstabDisplay = "hours" | "kcal" | "score";
export type MoodCrosstabMode = "sameDay" | "nextDay";

export interface MoodTagMetricCrosstabRow {
  tag: string;
  labelKey: string;
  categoryKey: string;
  icon: string | null;
  metricKey: string;
  display: MoodCrosstabDisplay;
  mode: MoodCrosstabMode;
  withDays: number;
  withoutDays: number;
  withAvg: number;
  withoutAvg: number;
  delta: number;
  pValue: number;
  qValue: number;
  confidence: MoodInfluenceConfidence;
}

const METRIC_LABEL_KEY: Record<string, string> = {
  activeEnergy: "insights.mood.crosstab.metricActiveEnergy",
  sleepDuration: "insights.mood.crosstab.metricSleepDuration",
  nextDayRecovery: "insights.mood.crosstab.metricNextDayRecovery",
};

const UNIT_KEY: Record<MoodCrosstabDisplay, string> = {
  hours: "insights.mood.crosstab.unitHours",
  kcal: "insights.mood.crosstab.unitKcal",
  score: "insights.mood.crosstab.unitScore",
};

const CONFIDENCE_KEY: Record<MoodInfluenceConfidence, string> = {
  low: "insights.mood.influence.confidenceLow",
  medium: "insights.mood.influence.confidenceMedium",
  high: "insights.mood.influence.confidenceHigh",
};

// Confidence chips carry COLORED TEXT, so they ride the semantic feedback
// tokens (`--info` / `--success`) — these carry the Alucard light-mode
// overrides that clear AA on the white card. Raw `--dracula-*` stays bright
// green/cyan in light mode and fails AA for text.
const CONFIDENCE_CLASS: Record<MoodInfluenceConfidence, string> = {
  low: "bg-secondary text-muted-foreground",
  medium: "bg-info/15 text-info",
  high: "bg-success/15 text-success",
};

/** One decimal for hours/score, whole numbers for kcal. */
function fmt(value: number, display: MoodCrosstabDisplay): string {
  return display === "kcal" ? Math.round(value).toString() : value.toFixed(1);
}

export function MoodTagMetricCrosstab({
  rows,
}: {
  rows: MoodTagMetricCrosstabRow[];
}) {
  const { t } = useTranslations();
  if (rows.length === 0) return null;

  return (
    <div data-slot="mood-tag-metric-crosstab">
      <p className="text-muted-foreground mb-2 text-sm">
        {t("insights.mood.crosstab.description")}
      </p>
      <ul className="divide-border divide-y">
        {rows.map((row) => {
          const Icon = moodTagIcon(row.icon);
          const tagLabel = t(row.labelKey);
          const metricLabel = t(
            METRIC_LABEL_KEY[row.metricKey] ?? row.metricKey,
          );
          const unit = t(UNIT_KEY[row.display]);
          const up = row.delta >= 0;
          const deltaText = `${up ? "+" : ""}${fmt(row.delta, row.display)} ${unit}`;
          // Semantic feedback tokens (not raw `--dracula-*`): the delta read-out
          // is COLORED TEXT, so it needs the Alucard light-mode override for AA.
          const deltaColor = up
            ? "var(--success)"
            : "var(--destructive)";
          return (
            <li
              key={`${row.metricKey}:${row.tag}`}
              className="flex flex-col gap-1.5 py-2"
              data-slot="mood-crosstab-row"
              data-metric={row.metricKey}
              data-direction={up ? "up" : "down"}
              data-confidence={row.confidence}
            >
              <div className="flex items-center gap-2 text-sm">
                {Icon && (
                  <Icon
                    className="text-muted-foreground h-4 w-4 shrink-0"
                    aria-hidden="true"
                  />
                )}
                <span
                  className="text-foreground min-w-0 flex-1 truncate"
                  title={`${tagLabel} · ${metricLabel}`}
                >
                  {t("insights.mood.crosstab.pairLabel", {
                    tag: tagLabel,
                    metric: metricLabel,
                  })}
                </span>
                <span
                  className="shrink-0 text-sm font-semibold tabular-nums"
                  style={{ color: deltaColor }}
                >
                  {deltaText}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                    CONFIDENCE_CLASS[row.confidence],
                  )}
                >
                  {t(CONFIDENCE_KEY[row.confidence])}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                {t(
                  row.mode === "nextDay"
                    ? "insights.mood.crosstab.detailNextDay"
                    : "insights.mood.crosstab.detailSameDay",
                  {
                    withAvg: fmt(row.withAvg, row.display),
                    withoutAvg: fmt(row.withoutAvg, row.display),
                    unit,
                    withDays: row.withDays,
                  },
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
