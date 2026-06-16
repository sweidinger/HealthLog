"use client";

/**
 * v1.18.1 P3 — the cross-episode retrospective summary card ("Your illness
 * history"): how many episodes in the window + the typical recovery gap, with
 * a calm "still learning" line until enough resolved episodes back the figure.
 * Retrospective only — a count of the past, never a forecast.
 */
import { History } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";

import { useIllnessInsights } from "./use-illness";

export function IllnessInsightsCard({ windowDays = 365 }: { windowDays?: number }) {
  const { t } = useTranslations();
  const { data, isLoading, isError } = useIllnessInsights(windowDays);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <History className="text-muted-foreground h-4 w-4" aria-hidden />
          <h2 className="text-base font-semibold">
            {t("illness.insights.title")}
          </h2>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : isError || !data ? (
          <p className="text-muted-foreground text-sm">
            {t("illness.insights.none")}
          </p>
        ) : data.episodeCount === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("illness.insights.none")}
          </p>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-foreground">
              {data.episodeCount === 1
                ? t("illness.insights.countOne")
                : t("illness.insights.countOther", { count: data.episodeCount })}
            </p>
            <p className="text-muted-foreground">
              {data.typicalRecoveryGapDays !== null
                ? t("illness.insights.typicalGap", {
                    days: data.typicalRecoveryGapDays,
                  })
                : t("illness.insights.typicalGapLearning")}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
