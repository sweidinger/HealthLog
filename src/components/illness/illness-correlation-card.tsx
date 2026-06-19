"use client";

/**
 * v1.18.1 P3 — the per-episode retrospective correlation card ("How it
 * unfolded"). Server-authoritative + coverage-gated: it pattern-matches the
 * `Derived<T>` `status` and renders "still learning" when the signal is thin,
 * NEVER a fabricated number. Retrospective only — never a prediction or a
 * diagnosis. Neutral palette throughout (the med-card no-colour rule
 * generalised); the red-flag is a calm "worth a closer look" note, framed to
 * escalate without alarming colour.
 */
import { ArrowDown, ArrowUp, Info } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";

import { useIllnessCorrelation } from "./use-illness";
import type { IllnessCorrelationValue, IllnessVitalDeviation } from "./types";

/** Translate a MeasurementType to its illness-surface label. */
function useVitalLabel() {
  const { t } = useTranslations();
  return (type: string) => t(`illness.vital.${type}`);
}

function DeviationRow({ d }: { d: IllnessVitalDeviation }) {
  const { t } = useTranslations();
  const vitalLabel = useVitalLabel();
  const Arrow = d.direction === "above" ? ArrowUp : ArrowDown;
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="text-foreground min-w-0 truncate">
        {vitalLabel(d.type)}
      </span>
      <span className="text-muted-foreground flex shrink-0 items-center gap-1 tabular-nums">
        <Arrow className="h-3.5 w-3.5" aria-hidden />
        {t(`illness.correlation.direction.${d.direction}`)}
      </span>
    </li>
  );
}

function CorrelationBody({ value }: { value: IllnessCorrelationValue }) {
  const { t } = useTranslations();
  const gap = value.recoveryGapDays;

  return (
    <div className="space-y-5">
      {value.redFlags.length > 0 ? (
        <div className="border-border bg-muted/40 rounded-lg border p-3">
          <p className="text-foreground text-sm font-medium">
            {t("illness.correlation.redFlagTitle")}
          </p>
          <ul className="text-muted-foreground mt-1 space-y-1 text-sm">
            {value.redFlags.map((f) => (
              <li key={`${f.type}:${f.reason}`}>
                {f.reason === "sustained_low_spo2"
                  ? t("illness.correlation.redFlagSpo2")
                  : t("illness.correlation.redFlagFever")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {gap !== null ? (
        <div>
          <p className="text-foreground text-sm font-medium">
            {t("illness.correlation.recoveryGapTitle")}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {gap > 0
              ? t("illness.correlation.recoveryGapLag", { days: gap })
              : gap < 0
                ? t("illness.correlation.recoveryGapLead", {
                    days: Math.abs(gap),
                  })
                : t("illness.correlation.recoveryGapSame")}
          </p>
        </div>
      ) : null}

      {value.preOnset.length > 0 ? (
        <div>
          <p className="text-foreground text-sm font-medium">
            {t("illness.correlation.preOnsetTitle")}
          </p>
          <p className="text-muted-foreground mt-1 mb-2 text-xs">
            {t("illness.correlation.preOnsetBody")}
          </p>
          <ul className="space-y-1.5">
            {value.preOnset.map((d) => (
              <DeviationRow key={`pre:${d.type}`} d={d} />
            ))}
          </ul>
        </div>
      ) : null}

      {value.nadir.length > 0 ? (
        <div>
          <p className="text-foreground text-sm font-medium">
            {t("illness.correlation.nadirTitle")}
          </p>
          <p className="text-muted-foreground mt-1 mb-2 text-xs">
            {t("illness.correlation.nadirBody")}
          </p>
          <ul className="space-y-1.5">
            {value.nadir.map((d) => (
              <DeviationRow key={`nadir:${d.type}`} d={d} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function IllnessCorrelationCard({ episodeId }: { episodeId: string }) {
  const { t } = useTranslations();
  const { data, isLoading, isError } = useIllnessCorrelation(episodeId);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Info className="text-muted-foreground h-4 w-4" aria-hidden />
          <h2 className="text-base font-semibold">
            {t("illness.correlation.title")}
          </h2>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : isError || !data || data.status !== "ok" || !data.value ? (
          <p className="text-muted-foreground text-sm">
            {t("illness.correlation.learning")}
          </p>
        ) : (
          <CorrelationBody value={data.value} />
        )}
      </CardContent>
    </Card>
  );
}
