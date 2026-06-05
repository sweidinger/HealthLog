"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { moodTagIcon } from "@/components/mood/mood-tag-icons";
import { cn } from "@/lib/utils";
import type { MoodInfluenceConfidence } from "./mood-tag-influence";

/**
 * v1.11.5 (F2) — "What's associated with your better days" board.
 *
 * One ranked, confidence-gated list folding the F1 tag deltas and the
 * mood × health-metric correlations into a single effect-size-ranked
 * surface — the headline "relations" answer to "what goes with my good
 * days?". The merge + ranking is pre-computed in `mood-aggregates.ts`
 * (`computeBetterDays`); this component only paints. Observational only;
 * the standing "describes your own data, not a diagnosis" disclaimer lives
 * once in the page-level Insights footer, not on this board.
 */

export interface MoodBetterDayFactor {
  source: "tag" | "metric";
  key: string;
  labelKey: string | null;
  categoryKey: string | null;
  icon: string | null;
  direction: "up" | "down";
  n: number;
  confidence: MoodInfluenceConfidence;
  effectSize: number;
  delta: number | null;
  r: number | null;
}

const METRIC_LABEL_KEY: Record<string, string> = {
  sleep: "insights.mood.correlation.sleepTitle",
  steps: "insights.mood.correlation.stepsTitle",
  pulse: "insights.mood.correlation.pulseTitle",
  weight: "insights.mood.correlation.weightTitle",
  bloodPressureSystolic: "insights.mood.correlation.bloodPressureTitle",
};

const CONFIDENCE_KEY: Record<MoodInfluenceConfidence, string> = {
  low: "insights.mood.influence.confidenceLow",
  medium: "insights.mood.influence.confidenceMedium",
  high: "insights.mood.influence.confidenceHigh",
};

const CONFIDENCE_CLASS: Record<MoodInfluenceConfidence, string> = {
  low: "bg-secondary text-muted-foreground",
  medium: "bg-[color:var(--dracula-cyan)]/15 text-[color:var(--dracula-cyan)]",
  high: "bg-[color:var(--dracula-green)]/15 text-[color:var(--dracula-green)]",
};

export function MoodBetterDays({
  factors,
}: {
  factors: MoodBetterDayFactor[];
}) {
  const { t } = useTranslations();
  if (factors.length === 0) return null;

  return (
    <div data-slot="mood-better-days">
      <p className="text-muted-foreground mb-2 text-sm">
        {t("insights.mood.betterDays.description")}
      </p>
      <ul className="divide-border divide-y">
        {factors.map((factor) => {
          const up = factor.direction === "up";

          let label: string;
          let Icon: ReturnType<typeof moodTagIcon> | null = null;
          if (factor.source === "metric") {
            label = t(METRIC_LABEL_KEY[factor.key] ?? factor.key);
          } else if (factor.labelKey) {
            label = t(factor.labelKey);
            Icon = moodTagIcon(factor.icon);
          } else {
            label = factor.key;
          }

          const DirectionIcon = up ? ArrowUpRight : ArrowDownRight;
          const directionColor = up
            ? "var(--dracula-green)"
            : "var(--dracula-red)";

          // The effect read-out: tag factors show the mood-point delta,
          // metric factors show the correlation coefficient.
          const effectText =
            factor.source === "tag" && factor.delta != null
              ? `${factor.delta >= 0 ? "+" : ""}${factor.delta.toFixed(1)}`
              : factor.r != null
                ? `r ${factor.r.toFixed(2)}`
                : "";

          return (
            <li
              key={`${factor.source}:${factor.key}`}
              className="flex items-center gap-2 py-2 text-sm"
              data-slot="mood-better-day-factor"
              data-source={factor.source}
              data-direction={factor.direction}
              data-confidence={factor.confidence}
            >
              <DirectionIcon
                className="h-4 w-4 shrink-0"
                style={{ color: directionColor }}
                aria-hidden="true"
              />
              {Icon && (
                <Icon
                  className="text-muted-foreground h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
              )}
              <span
                className="text-foreground min-w-0 flex-1 truncate"
                title={label}
              >
                {label}
              </span>
              <span
                className="shrink-0 text-xs font-semibold tabular-nums"
                style={{ color: directionColor }}
              >
                {effectText}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                  CONFIDENCE_CLASS[factor.confidence],
                )}
              >
                {t(CONFIDENCE_KEY[factor.confidence])}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
