"use client";

import { Moon } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InfoHint } from "@/components/ui/info-hint";
import { TileHeader } from "@/components/insights/tile-header";
import { LearningGate } from "@/components/ui/learning-gate";
import type { SleepDebtDto } from "./use-sleep-rhythm";

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
 * v1.17.0 — sleep-debt headline.
 *
 * The cumulative shortfall between sleep need and sleep obtained over the
 * rolling window. Under the night threshold it shows the calm `partial`
 * state ("still learning — N more nights") and never asserts a total off thin
 * data. Mobile-first: a single readable figure + one line of grounded context.
 */
export function SleepDebtCard({ debt }: { debt: SleepDebtDto }) {
  const { t } = useTranslations();

  if (debt.state === "partial") {
    return (
      <Card>
        <CardHeader>
          {/* v1.25.0 — when the active source on the user's sleep-debt ladder
              is our own COMPUTED engine (every user today, until a provider
              ships a native debt), explain what the figure means and that it
              differs from a wearable's native number. */}
          <TileHeader
            icon={Moon}
            title={t("insights.sleep.debt.title")}
            right={
              debt.source === "COMPUTED" ? (
                <InfoHint label={t("insights.sleep.debt.computedInfo")} />
              ) : undefined
            }
          />
        </CardHeader>
        <CardContent>
          <LearningGate
            message={t("insights.sleep.debt.learning", {
              counted: debt.nightsCounted,
              remaining: debt.nightsUntilReady,
            })}
          />
        </CardContent>
      </Card>
    );
  }

  const { hours, minutes } = hoursMinutes(debt.debtMinutes);
  const isClear = debt.debtMinutes === 0;

  return (
    <Card>
      <CardHeader>
        {/* v1.25.0 — the resolved full-debt card is the common case and the
            place the figure most needs context: explain the COMPUTED engine
            and that it differs from a wearable's native number here too, not
            only in the still-learning `partial` state above. */}
        <TileHeader
          icon={Moon}
          title={t("insights.sleep.debt.title")}
          right={
            debt.source === "COMPUTED" ? (
              <InfoHint label={t("insights.sleep.debt.computedInfo")} />
            ) : undefined
          }
        />
      </CardHeader>
      <CardContent>
        <div className="space-y-0.5">
          <p className="text-2xl font-semibold tabular-nums">
            {isClear
              ? t("insights.sleep.debt.clearValue")
              : t("insights.sleep.debt.value", { hours, minutes })}
          </p>
          <p className="text-muted-foreground text-xs">
            {isClear
              ? t("insights.sleep.debt.clearCaption", {
                  nights: debt.windowNights,
                })
              : t("insights.sleep.debt.caption", {
                  nights: debt.windowNights,
                })}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
