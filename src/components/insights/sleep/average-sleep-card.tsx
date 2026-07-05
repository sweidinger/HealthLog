"use client";

import { BedDouble } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LearningGate } from "@/components/ui/learning-gate";
import type { AverageSleepDto } from "./use-sleep-rhythm";

/** Whole hours + minutes from a minute total, for the headline figure. */
function hoursMinutes(totalMinutes: number): {
  hours: number;
  minutes: number;
} {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes - hours * 60);
  return { hours, minutes };
}

/**
 * v1.19.1 — average-sleep-per-night headline.
 *
 * The third peer of `<SleepDebtCard>` + `<ChronotypeCard>`: identical card
 * chrome (icon + `text-base` `CardTitle` header, a `space-y-0.5` block with a
 * bold `text-2xl` primary value and one `text-xs` muted secondary line) so the
 * three tiles read uniformly in the shared grid row. The figure is the mean of
 * the canonical per-night asleep totals over the same scorable-night window the
 * debt + chronotype read — server-authoritative, never recomputed here. Under
 * the night floor it shows the calm `partial` state and asserts no average.
 */
export function AverageSleepCard({ average }: { average: AverageSleepDto }) {
  const { t } = useTranslations();

  if (average.state === "partial") {
    return (
      <Card data-slot="average-sleep-card">
        <CardHeader>
          <div className="flex items-center gap-2">
            <BedDouble className="text-info h-4 w-4" />
            <CardTitle className="text-base font-semibold">
              {t("insights.sleep.average.title")}
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <LearningGate
            message={t("insights.sleep.average.learning", {
              counted: average.nightsCounted,
              remaining: average.nightsUntilReady,
            })}
          />
        </CardContent>
      </Card>
    );
  }

  const { hours, minutes } = hoursMinutes(average.averageMinutes);

  return (
    <Card data-slot="average-sleep-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <BedDouble className="text-info h-4 w-4" />
          <CardTitle className="text-base font-semibold">
            {t("insights.sleep.average.title")}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-0.5">
          <p className="text-2xl font-semibold tabular-nums">
            {t("insights.sleep.average.value", { hours, minutes })}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("insights.sleep.average.caption", {
              nights: average.nightsCounted,
            })}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
