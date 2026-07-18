"use client";

import { Sparkles } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Reserved Activity-Insight seam (strategic-concept Wave C, bet 5).
 *
 * NOTHING renders here today: the workout payload's `aiInsight` field is
 * always `null`, so the page composes `{aiInsight ? <WorkoutInsightCard
 * insight={aiInsight}/> : null}` and this component never mounts. The
 * shape below is what the Phase-2 pg-boss job will write onto the
 * workout row — when it lands, the server maps the row to `aiInsight`,
 * the union in `use-workouts.ts` widens from `null` to
 * `WorkoutActivityInsightData | null`, and the card mounts right under
 * the hero header with zero layout rework. Non-diagnostic by
 * construction: a descriptive paragraph, device-attributed, never a
 * verdict.
 */
export interface WorkoutActivityInsightData {
  /** The cached, plain-text insight paragraph. Rendered as text children. */
  paragraph: string;
  /** ISO timestamp the paragraph was generated. */
  generatedAt: string;
}

export function WorkoutInsightCard({
  insight,
}: {
  insight: WorkoutActivityInsightData;
}) {
  const { t } = useTranslations();
  return (
    <Card data-slot="workout-detail-insight">
      <CardHeader>
        <TileHeader
          icon={Sparkles}
          title={t("insights.workouts.detail.insightTitle")}
        />
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-relaxed">{insight.paragraph}</p>
      </CardContent>
    </Card>
  );
}
