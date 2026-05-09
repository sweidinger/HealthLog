"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/lib/i18n/context";
import type {
  InsightRecommendation,
  InsightRecommendationRationale,
} from "@/lib/ai/types";
import { HealthChart } from "@/components/charts/health-chart";
import { MoodChart } from "@/components/charts/mood-chart";
import { getMedicalReferenceById } from "@/lib/ai/medical-references";
import type { Locale } from "@/lib/i18n/config";

/**
 * v1.4.16 phase B5c — Oura-style RecommendationCard.
 *
 * Each recommendation lives in its own collapsible card. The
 * collapsed row shows: severity badge + rec text + named slot for
 * the future confidence-ring (B5d) + chevron toggle.
 *
 * Expanding reveals:
 *   - 3-row rationale card (Window / Compared to / Deviation)
 *   - mini-chart pinned to the rationale's data window via
 *     HealthChart's new `mini` + `windowOverride` props
 *   - citation footnote (B5a) when `referenceId` resolves
 *   - named slot for the future feedback-thumbs (B5e)
 *
 * Default state: collapsed. Chevron toggles `aria-expanded`. Plain-
 * string recs (legacy InsightResult shape) and recs without
 * `rationale` render as a non-expandable list item — there's nothing
 * to expand to. The legacy-payload CTA at the parent advisor card
 * level surfaces the regenerate prompt for those.
 *
 * Layout slots are deliberately named so B5d (confidence) and B5e
 * (feedback) can plug in without touching this file:
 *
 *   - data-slot="rec-confidence-slot"  → B5d ConfidenceRing
 *   - data-slot="rec-feedback-slot"    → B5e RecommendationFeedback
 */

const SEVERITY_BADGE_STYLES: Record<string, string> = {
  info: "bg-dracula-cyan/10 text-dracula-cyan border border-dracula-cyan/25",
  suggestion:
    "bg-dracula-purple/10 text-dracula-purple border border-dracula-purple/25",
  important:
    "bg-dracula-orange/10 text-dracula-orange border border-dracula-orange/25",
  urgent: "bg-dracula-red/10 text-dracula-red border border-dracula-red/25",
};

interface RecommendationCardProps {
  rec: InsightRecommendation;
  index: number;
  /** Force the rationale block visible — mostly for tests + storybook. */
  initiallyExpanded?: boolean;
}

interface NormalisedRec {
  text: string;
  severity?: "info" | "suggestion" | "important" | "urgent";
  rationale?: InsightRecommendationRationale;
  metricSource?: { type: string; timeRange: string; summary: string };
  referenceId?: string;
  id?: string;
}

function normalise(rec: InsightRecommendation): NormalisedRec {
  if (typeof rec === "string") return { text: rec };
  return {
    text: rec.text,
    severity: rec.severity,
    rationale: rec.rationale,
    metricSource: rec.metricSource,
    referenceId: rec.referenceId,
    id: rec.id,
  };
}

/**
 * Map a `metricSource.type` value to the chart-types[] the dashboard
 * uses. The model speaks snapshot-key vocabulary ("bloodPressure",
 * "weight", "pulse", "mood", "medications.compliance30") which
 * doesn't 1:1 match the measurement-type enum the chart consumes
 * ("BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "WEIGHT", …). This
 * map is deliberately tight; unknown types fall through to a single-
 * type chart so a future provider that emits a new key still renders
 * something rather than nothing.
 */
function metricTypeToChartTypes(metricType: string | undefined): string[] {
  if (!metricType) return [];
  const lower = metricType.toLowerCase();
  if (lower === "bloodpressure" || lower === "blood_pressure") {
    return ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"];
  }
  if (lower === "weight") return ["WEIGHT"];
  if (lower === "pulse") return ["PULSE"];
  if (lower === "bodyfat" || lower === "body_fat") return ["BODY_FAT"];
  if (lower === "sleep" || lower === "sleep_duration") {
    return ["SLEEP_DURATION"];
  }
  if (lower === "activity" || lower === "steps") {
    return ["ACTIVITY_STEPS"];
  }
  if (lower === "bloodglucose" || lower === "blood_glucose") {
    return ["BLOOD_GLUCOSE"];
  }
  // Unknown / synthetic key — pass it through verbatim so the chart
  // can render empty rather than nothing.
  return [metricType];
}

function isMoodMetric(metricType: string | undefined): boolean {
  return metricType?.toLowerCase() === "mood";
}

function isComplianceMetric(metricType: string | undefined): boolean {
  return (
    metricType?.toLowerCase().startsWith("medications.compliance") === true ||
    metricType?.toLowerCase() === "medication"
  );
}

function CitationFootnote({
  referenceId,
  locale,
}: {
  referenceId: string;
  locale: Locale;
}) {
  const { t } = useTranslations();
  const ref = getMedicalReferenceById(referenceId);
  if (!ref) return null;
  const label = locale === "de" ? ref.titleDe : ref.title;
  return (
    <a
      href={ref.url}
      target="_blank"
      rel="noreferrer"
      title={t("insights.recommendation.viewSource")}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
      data-slot="insight-recommendation-source"
      data-reference-id={referenceId}
    >
      <span className="font-medium">
        {t("insights.recommendation.source")}:
      </span>
      <span>
        {ref.org} {ref.publishedYear} — {label}
      </span>
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

function RationaleRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="grid grid-cols-[7rem_1fr] items-start gap-2 text-xs"
      data-slot="rec-rationale-row"
    >
      <span className="text-muted-foreground font-medium">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function RationaleCard({
  rationale,
  metricSource,
  referenceId,
  locale,
}: {
  rationale: InsightRecommendationRationale;
  metricSource: { type: string; timeRange: string; summary: string } | undefined;
  referenceId: string | undefined;
  locale: Locale;
}) {
  const { t } = useTranslations();
  const metricType = metricSource?.type;
  const chartTypes = metricTypeToChartTypes(metricType);

  return (
    <div
      data-slot="rec-rationale-card"
      className="bg-muted/30 mt-3 space-y-3 rounded-md px-3 py-2.5"
    >
      <div className="space-y-1.5">
        <RationaleRow
          label={t("insights.recommendation.rationaleWindow")}
          value={rationale.dataWindow}
        />
        <RationaleRow
          label={t("insights.recommendation.rationaleComparedTo")}
          value={rationale.comparedTo}
        />
        <RationaleRow
          label={t("insights.recommendation.rationaleDeviation")}
          value={rationale.deviation}
        />
      </div>

      {/* Mini-chart pinned to the rec's window. mood + medication-
          compliance get dedicated wrappers; everything else routes
          through HealthChart with the metric-key vocabulary. */}
      {isMoodMetric(metricType) ? (
        <MoodChart mini windowOverride={rationale.dataWindow} />
      ) : isComplianceMetric(metricType) ? null : chartTypes.length > 0 ? (
        <HealthChart
          types={chartTypes}
          title={metricType ?? ""}
          mini
          windowOverride={rationale.dataWindow}
        />
      ) : null}

      {referenceId && (
        <div>
          <CitationFootnote referenceId={referenceId} locale={locale} />
        </div>
      )}

      <div data-slot="rec-feedback-slot" />
    </div>
  );
}

export function RecommendationCard({
  rec,
  index,
  initiallyExpanded = false,
}: RecommendationCardProps) {
  const { t, locale } = useTranslations();
  const norm = normalise(rec);
  const expandable = norm.rationale !== undefined;
  const [expanded, setExpanded] = useState(initiallyExpanded);

  return (
    <li
      data-slot="rec-card"
      data-index={index}
      className="border-border/40 bg-card/20 rounded-lg border px-3 py-2.5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span
            className="text-muted-foreground mt-0.5 shrink-0 text-xs font-medium tabular-nums"
            aria-hidden="true"
          >
            {index + 1}.
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {norm.severity && (
                <Badge
                  className={`text-[10px] tracking-wide uppercase ${
                    SEVERITY_BADGE_STYLES[norm.severity] ?? ""
                  }`}
                  variant="outline"
                >
                  {norm.severity}
                </Badge>
              )}
              <p className="text-sm leading-snug">{norm.text}</p>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span data-slot="rec-confidence-slot" />
          {expandable && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors"
              title={
                expanded
                  ? t("insights.recommendation.rationaleCollapse")
                  : t("insights.recommendation.rationaleExpand")
              }
              data-slot="rec-expand-toggle"
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
      </div>

      {expandable && expanded && norm.rationale && (
        <div
          className="animate-insight-in"
          style={{ animationDuration: "200ms" }}
        >
          <RationaleCard
            rationale={norm.rationale}
            metricSource={norm.metricSource}
            referenceId={norm.referenceId}
            locale={locale}
          />
        </div>
      )}

      {/* Inline-only citation footnote: a legacy rec (no rationale)
       * still surfaces its medical reference under the rec text.
       * Recs WITH rationale only render the footnote inside the
       * expanded RationaleCard so it doesn't double-print. */}
      {!expandable && norm.referenceId && (
        <div className="mt-1 ml-6">
          <CitationFootnote referenceId={norm.referenceId} locale={locale} />
        </div>
      )}
    </li>
  );
}
