"use client";

/**
 * v1.18.2 — the per-day timeline anchor, hosted exclusively on the episode
 * detail surface. It surfaces today's logged day (symptoms with their 0–3
 * severity, functional impact, fever) so the detail page owns the day-log
 * content the list rows no longer carry. Retrospective only — a record of
 * what was logged, never a forecast. Neutral palette throughout.
 *
 * The read uses the single-day `useIllnessDayLog` hook (the only day-log read
 * the API exposes); when nothing is logged for the day it renders a calm
 * prompt to log it.
 */
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

import { ILLNESS_SYMPTOM_CATALOG } from "./symptom-catalog";
import { useIllnessDayLog } from "./use-illness";

function symptomLabelKey(key: string): string | null {
  return ILLNESS_SYMPTOM_CATALOG.find((s) => s.key === key)?.labelKey ?? null;
}

export function IllnessDayTimeline({
  episodeId,
  date,
  onLogDay,
}: {
  episodeId: string;
  date: string;
  onLogDay: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { data, isLoading, isError } = useIllnessDayLog(episodeId, date);

  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold">
          {t("illness.timeline.title")}
        </h2>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : isError ? (
          <p className="text-muted-foreground text-sm">
            {t("illness.timeline.error")}
          </p>
        ) : !data ? (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {t("illness.timeline.emptyToday")}
            </p>
            <Button
              variant="outline"
              className="min-h-11 sm:min-h-9"
              onClick={onLogDay}
            >
              {t("illness.logDay")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2.5 text-sm">
            <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              {t("illness.timeline.today", {
                date: fmt.dateShort(`${data.date}T12:00:00`),
              })}
            </p>

            {data.symptoms.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {data.symptoms.map((s) => {
                  const labelKey = symptomLabelKey(s.key);
                  if (!labelKey) return null;
                  return (
                    <Badge key={s.key} variant="secondary">
                      {t(labelKey)}
                      {typeof s.severity === "number"
                        ? ` · ${t("illness.timeline.severity", {
                            severity: s.severity,
                          })}`
                        : ""}
                    </Badge>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground">
                {t("illness.timeline.noSymptoms")}
              </p>
            )}

            {data.functionalImpact !== null ? (
              <p className="text-foreground">
                {t("illness.timeline.impact", {
                  impact: t(`illness.impact.${data.functionalImpact}`),
                })}
              </p>
            ) : null}

            {data.feverC !== null ? (
              <p className="text-foreground">
                {t("illness.timeline.fever", {
                  value: fmt.number(data.feverC, 1),
                })}
              </p>
            ) : null}

            {data.note ? (
              <p className="text-muted-foreground whitespace-pre-wrap">
                {data.note}
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
