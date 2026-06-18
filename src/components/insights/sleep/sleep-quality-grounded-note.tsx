"use client";

import { Moon } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import type { DataSummary } from "@/lib/analytics/trends";
import {
  buildSleepQualityAssessment,
  type QualityGrade,
  type SleepQualityFinding,
} from "./sleep-quality-assessment";

/**
 * v1.18.6 — the grounded sleep-quality "Einschätzung".
 *
 * The AI assessment under the sleep-quality block reads "no assessment yet"
 * until a provider has run, and stays blank forever on an account with no AI
 * provider. This card fills that gap with a substantive read built ENTIRELY
 * from the user's own quality averages (efficiency / performance / consistency
 * / headline score) graded against recognised reference bands — no provider,
 * no recompute of a stored value. It describes; it does not diagnose.
 *
 * Mounted only when the AI assessment is NOT present (`showWhenAiAbsent`), so
 * the richer AI narrative still wins when it exists and the user never sees
 * two assessments stacked.
 */

const QUALITY_TYPES = [
  "SLEEP_SCORE",
  "SLEEP_EFFICIENCY",
  "SLEEP_PERFORMANCE",
  "SLEEP_CONSISTENCY",
] as const;

/** Map a finding to its localised "{metric} is {grade} at {value}" clause. */
function clauseFor(
  finding: SleepQualityFinding,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const metricLabel = t(`insights.sleepQuality.assessment.metric.${finding.type}`);
  const gradeLabel = t(`insights.sleepQuality.assessment.grade.${finding.grade}`);
  // Efficiency / performance / consistency are percentages; the headline score
  // is a 0–100 index. Both read naturally as a rounded integer.
  const value = Math.round(finding.value);
  return t("insights.sleepQuality.assessment.clause", {
    metric: metricLabel,
    grade: gradeLabel,
    value,
  });
}

export interface SleepQualityGroundedNoteProps {
  /** The analytics summaries the section already holds (no extra fetch). */
  summaries: Record<string, DataSummary | undefined> | undefined;
  /**
   * Whether the AI assessment is absent. The grounded note only renders when
   * the AI narrative is not there, so the two never stack.
   */
  showWhenAiAbsent: boolean;
}

export function SleepQualityGroundedNote({
  summaries,
  showWhenAiAbsent,
}: SleepQualityGroundedNoteProps) {
  const { t } = useTranslations();

  if (!showWhenAiAbsent || !summaries) return null;

  const reads = QUALITY_TYPES.map((type) => {
    const s = summaries[type];
    const value = s?.avg30 ?? s?.avg7 ?? s?.latest ?? null;
    return value == null
      ? null
      : ({ type, value } as { type: string; value: number });
  }).filter((r): r is { type: string; value: number } => r !== null);

  const assessment = buildSleepQualityAssessment(reads);
  if (!assessment) return null;

  const clauses = [assessment.lead, ...assessment.rest].map((f) =>
    clauseFor(f, t),
  );
  const closing = t(
    `insights.sleepQuality.assessment.closing.${assessment.overall as QualityGrade}`,
  );

  return (
    <Card
      data-slot="sleep-quality-grounded-note"
      className="gap-1.5 py-4 md:py-5"
    >
      <CardHeader className="pb-1">
        <TileHeader
          icon={QualityNoteIcon}
          title={t("insights.assessmentTitle")}
        />
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-muted-foreground text-sm leading-relaxed">
          {clauses.join(" ")} {closing}
        </p>
      </CardContent>
    </Card>
  );
}

function QualityNoteIcon({ className }: { className?: string }) {
  return <Moon className={className} aria-hidden="true" />;
}
