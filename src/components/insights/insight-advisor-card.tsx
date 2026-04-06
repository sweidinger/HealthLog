"use client";

import { useState } from "react";
import type { InsightResult, InsightFinding } from "@/lib/ai/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sparkles,
  RefreshCw,
  Loader2,
  CheckCircle2,
  Minus,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Info,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────

interface InsightAdvisorCardProps {
  title: string;
  icon?: React.ReactNode;
  insight: InsightResult | null;
  loading?: boolean;
  error?: string | null;
  onRegenerate?: () => void;
  regenerating?: boolean;
  cachedAt?: string | null;
}

// ─── Classification Colors ───────────────────────────────

const CLASSIFICATION_STYLES: Record<
  string,
  { badge: string; border: string }
> = {
  optimal: {
    badge:
      "bg-[#50fa7b]/10 text-[#50fa7b] border border-[#50fa7b]/25 hover:bg-[#50fa7b]/15",
    border: "border-l-[#50fa7b]",
  },
  gut: {
    badge:
      "bg-[#8be9fd]/10 text-[#8be9fd] border border-[#8be9fd]/25 hover:bg-[#8be9fd]/15",
    border: "border-l-[#8be9fd]",
  },
  grenzwertig: {
    badge:
      "bg-[#f1fa8c]/10 text-[#f1fa8c] border border-[#f1fa8c]/25 hover:bg-[#f1fa8c]/15",
    border: "border-l-[#f1fa8c]",
  },
  erhoht: {
    badge:
      "bg-[#ffb86c]/10 text-[#ffb86c] border border-[#ffb86c]/25 hover:bg-[#ffb86c]/15",
    border: "border-l-[#ffb86c]",
  },
  kritisch: {
    badge:
      "bg-[#ff5555]/10 text-[#ff5555] border border-[#ff5555]/25 hover:bg-[#ff5555]/15",
    border: "border-l-[#ff5555]",
  },
};

// ─── Assessment Icons ─────────────────────────────────────

function AssessmentIcon({
  assessment,
}: {
  assessment: InsightFinding["assessment"];
}) {
  switch (assessment) {
    case "positive":
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-[#50fa7b]" />;
    case "neutral":
      return <Minus className="h-4 w-4 shrink-0 text-[#9aa3b3]" />;
    case "attention":
      return <AlertCircle className="h-4 w-4 shrink-0 text-[#ffb86c]" />;
    case "warning":
      return <AlertTriangle className="h-4 w-4 shrink-0 text-[#ff5555]" />;
  }
}

// ─── Confidence Colors ────────────────────────────────────

const CONFIDENCE_STYLES: Record<string, string> = {
  hoch: "text-[#50fa7b]",
  mittel: "text-[#f1fa8c]",
  gering: "text-[#ffb86c]",
};

// ─── Section Separator ────────────────────────────────────

function SectionSeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-medium text-muted-foreground">
      <span>{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────

export function InsightAdvisorCard({
  title,
  icon,
  insight,
  loading = false,
  error = null,
  onRegenerate,
  regenerating = false,
  cachedAt,
}: InsightAdvisorCardProps) {
  const [dataQualityOpen, setDataQualityOpen] = useState(false);

  const classStyle = insight
    ? CLASSIFICATION_STYLES[insight.classification] ??
      CLASSIFICATION_STYLES.gut
    : CLASSIFICATION_STYLES.gut;

  // ── Loading State ─────────────────────────────────────
  if (loading && !insight) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-[#bd93f9]" />
          <span className="ml-2 text-sm text-muted-foreground">
            {/* TODO: i18n */}
            Analyse wird erstellt...
          </span>
        </CardContent>
      </Card>
    );
  }

  // ── Empty / No Data State ─────────────────────────────
  if (!insight) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {icon ?? (
                <Sparkles className="h-5 w-5 text-[#bd93f9]" />
              )}
              {/* TODO: i18n */}
              <CardTitle className="text-lg">KI-Gesundheitsanalyse</CardTitle>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{title}</p>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          {!error && (
            <div className="flex flex-col items-center gap-3 py-6">
              <p className="text-sm text-muted-foreground">
                {/* TODO: i18n */}
                Noch keine Analyse vorhanden.
              </p>
              {onRegenerate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRegenerate}
                  disabled={regenerating}
                >
                  {regenerating ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {/* TODO: i18n */}
                  Analyse starten
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ── Full Insight Card ─────────────────────────────────
  return (
    <Card className="animate-insight-in">
      {/* Header */}
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon ?? (
              <Sparkles className="h-5 w-5 text-[#bd93f9]" />
            )}
            {/* TODO: i18n */}
            <CardTitle className="text-lg">KI-Gesundheitsanalyse</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={classStyle.badge}>
              {insight.classificationLabel ?? insight.classification}
            </Badge>
            {onRegenerate && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onRegenerate}
                disabled={regenerating}
                title="Analyse aktualisieren" // TODO: i18n
              >
                {regenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
              </Button>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{title}</p>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Primary Recommendation */}
        {insight.primaryRecommendation && (
          <div className="rounded-md border-l-2 border-[#bd93f9] bg-[#bd93f9]/5 px-4 py-3">
            <p className="mb-1 text-xs font-medium uppercase tracking-widest text-[#bd93f9]">
              {/* TODO: i18n */}
              Das Wichtigste
            </p>
            <p className="text-sm">{insight.primaryRecommendation}</p>
          </div>
        )}

        {/* Summary */}
        <p className="text-sm leading-relaxed text-muted-foreground">
          {insight.summary}
        </p>

        {/* Findings */}
        {insight.findings.length > 0 && (
          <div className="space-y-3">
            {/* TODO: i18n */}
            <SectionSeparator label="Befunde" />
            <div className="space-y-2">
              {insight.findings.map((finding, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <AssessmentIcon assessment={finding.assessment} />
                      <span className="text-sm">{finding.label}</span>
                    </div>
                    <span className="text-sm font-medium tabular-nums">
                      {finding.value}
                    </span>
                  </div>
                  {finding.guideline && (
                    <p className="ml-6 mt-0.5 text-xs text-muted-foreground">
                      {finding.guideline}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Correlations */}
        {insight.correlations.length > 0 && (
          <div className="space-y-3">
            {/* TODO: i18n */}
            <SectionSeparator label="Zusammenhänge" />
            <div className="flex flex-wrap gap-2">
              {insight.correlations.map((corr, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs"
                >
                  <span>{corr.factor}</span>
                  <span className="text-muted-foreground">↔</span>
                  <span>{corr.effect}</span>
                  <span
                    className={`ml-1 font-medium ${CONFIDENCE_STYLES[corr.confidence] ?? ""}`}
                  >
                    {corr.confidence}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recommendations */}
        {insight.recommendations.length > 0 && (
          <div className="space-y-3">
            {/* TODO: i18n */}
            <SectionSeparator label="Empfehlungen" />
            <ol className="space-y-1.5 pl-0">
              {insight.recommendations.map((rec, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <span className="shrink-0 font-medium text-muted-foreground">
                    {i + 1}.
                  </span>
                  <span>{rec}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Data Quality (collapsible) */}
        {insight.dataQuality && (
          <div>
            <button
              onClick={() => setDataQualityOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {dataQualityOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              {/* TODO: i18n */}
              <span>Datengrundlage</span>
              <span className="mx-1">·</span>
              <span>
                Konfidenz:{" "}
                <span
                  className={`font-medium ${CONFIDENCE_STYLES[insight.dataQuality.confidence] ?? ""}`}
                >
                  {insight.dataQuality.confidence === "hoch"
                    ? "Hoch"
                    : insight.dataQuality.confidence === "mittel"
                      ? "Mittel"
                      : "Gering"}
                </span>
              </span>
            </button>

            {dataQualityOpen && (
              <div className="mt-2 space-y-2 rounded-md bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground animate-insight-in">
                <p>{insight.dataQuality.coverage}</p>
                {insight.dataQuality.gaps.length > 0 && (
                  <div>
                    {/* TODO: i18n */}
                    <p className="font-medium">Datenlücken:</p>
                    <ul className="mt-1 list-inside list-disc space-y-0.5">
                      {insight.dataQuality.gaps.map((gap, i) => (
                        <li key={i}>{gap}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Cached timestamp */}
        {cachedAt && (
          <p className="text-xs text-muted-foreground">
            {/* TODO: i18n */}
            Zuletzt aktualisiert:{" "}
            {new Date(cachedAt).toLocaleString("de-DE", {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        )}

        {/* Disclaimer */}
        <div className="flex items-start gap-1.5 pt-1">
          <Info className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            {insight.disclaimer}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
