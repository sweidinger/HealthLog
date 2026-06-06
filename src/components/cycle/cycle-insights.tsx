"use client";

import { Activity } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import type { CycleInsightCard } from "./types";

/**
 * v1.15.0 — phase-correlation insight cards.
 *
 * Renders whatever phase-correlation cards the API surfaces (another wave
 * adds the data feed; this UI renders the list gracefully and shows the
 * empty-state when none). Each card carries the open statistics — sample
 * size, effect size, q-value — alongside the prose, matching the
 * FDR-guarded honest-reporting posture of the rest of Insights.
 */
export function CycleInsights({
  cards,
}: {
  cards: CycleInsightCard[];
}) {
  const { t } = useTranslations();

  if (cards.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="text-primary h-4 w-4" aria-hidden="true" />
            {t("cycle.insights.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {t("cycle.insights.empty")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-slot="cycle-insights">
      {cards.map((card) => (
        <Card key={card.id}>
          <CardHeader>
            <CardTitle className="text-base">{card.title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-foreground/90 text-sm">{card.body}</p>
            <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
              {card.n != null ? (
                <span>{t("cycle.insights.sampleSize", { n: card.n })}</span>
              ) : null}
              {card.effectSize != null ? (
                <span>
                  {t("cycle.insights.effectSize", {
                    value: card.effectSize.toFixed(2),
                  })}
                </span>
              ) : null}
              {card.qValue != null ? (
                <span>
                  {t("cycle.insights.qValue", {
                    value: card.qValue.toFixed(3),
                  })}
                </span>
              ) : null}
            </div>
            {card.caveat ? (
              <p className="text-muted-foreground text-xs italic">
                {card.caveat}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
