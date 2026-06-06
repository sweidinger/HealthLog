"use client";

import { Sparkles } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/lib/i18n/context";
import { CycleDisclaimer } from "./cycle-disclaimer";
import { FERTILE_HUE, FLOW_HUE, OVULATION_HUE } from "./phase-tokens";
import type { CyclePrediction, CycleHistoryResponse } from "./types";

/**
 * v1.15.0 — the predictions panel.
 *
 * Shows the next-period RANGE (a window, with a confidence pill), the fertile
 * window (already goal-gated server-side — the API nulls it unless TTC, so we
 * just render what is present), the "still learning" state for < 3 cycles or
 * raw-chart mode, the cycle-history stats, and the fixed non-medical
 * disclaimer. Never a single dated next-period claim — always the range.
 */

function formatDate(d: string): string {
  // Render at noon UTC so the YYYY-MM-DD never rolls a day across tz.
  return new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function confidenceTone(c: number): {
  labelKey: string;
  variant: "default" | "secondary" | "outline";
} {
  if (c >= 0.66)
    return { labelKey: "cycle.predictions.confidenceHigh", variant: "default" };
  if (c >= 0.33)
    return {
      labelKey: "cycle.predictions.confidenceMedium",
      variant: "secondary",
    };
  return { labelKey: "cycle.predictions.confidenceLow", variant: "outline" };
}

export interface PredictionsPanelProps {
  prediction: CyclePrediction | null;
  rawChartMode: boolean;
  history: CycleHistoryResponse | undefined;
  /** Fallback disclaimer when no prediction carries one. */
  fallbackDisclaimer?: string;
}

export function PredictionsPanel({
  prediction,
  rawChartMode,
  history,
  fallbackDisclaimer,
}: PredictionsPanelProps) {
  const { t } = useTranslations();

  const disclaimer = prediction?.disclaimer ?? fallbackDisclaimer ?? "";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="text-primary h-4 w-4" aria-hidden="true" />
            {t("cycle.predictions.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {rawChartMode ? (
            <Learning
              title={t("cycle.predictions.rawMode")}
              body={t("cycle.predictions.rawModeBody")}
            />
          ) : prediction == null ? (
            <p className="text-muted-foreground text-sm">
              {t("cycle.predictions.none")}
            </p>
          ) : prediction.stillLearning ? (
            <>
              <Learning
                title={t("cycle.predictions.stillLearning")}
                body={t("cycle.predictions.stillLearningBody")}
              />
              <NextPeriod prediction={prediction} />
            </>
          ) : (
            <>
              <NextPeriod prediction={prediction} />
              {prediction.fertileWindowStart && prediction.fertileWindowEnd ? (
                <Row
                  hue={FERTILE_HUE}
                  label={t("cycle.predictions.fertileWindow")}
                  value={`${formatDate(prediction.fertileWindowStart)} – ${formatDate(
                    prediction.fertileWindowEnd,
                  )}`}
                />
              ) : null}
              {prediction.predictedOvulation ? (
                <Row
                  hue={OVULATION_HUE}
                  label={t("cycle.predictions.ovulation")}
                  value={formatDate(prediction.predictedOvulation)}
                />
              ) : null}
            </>
          )}

          {disclaimer ? <CycleDisclaimer text={disclaimer} /> : null}
        </CardContent>
      </Card>

      <HistoryCard history={history} />
    </div>
  );
}

function NextPeriod({ prediction }: { prediction: CyclePrediction }) {
  const { t } = useTranslations();
  const tone = confidenceTone(prediction.confidence);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Row
          hue={FLOW_HUE}
          label={t("cycle.predictions.nextPeriod")}
          value={t("cycle.predictions.nextPeriodWindow", {
            low: formatDate(prediction.nextPeriodStartLow),
            high: formatDate(prediction.nextPeriodStartHigh),
          })}
        />
        <Badge variant={tone.variant} className="shrink-0">
          {t(tone.labelKey)}
        </Badge>
      </div>
    </div>
  );
}

function Row({
  hue,
  label,
  value,
}: {
  hue: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: hue }}
      />
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-foreground ml-auto text-sm font-medium tabular-nums">
        {value}
      </span>
    </div>
  );
}

function Learning({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-muted/40 rounded-md p-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 text-sm">{body}</p>
    </div>
  );
}

function HistoryCard({
  history,
}: {
  history: CycleHistoryResponse | undefined;
}) {
  const { t } = useTranslations();
  const stats = history?.stats;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("cycle.history.title")}</CardTitle>
        {stats ? (
          <CardDescription>
            {t(`cycle.history.regularity${stats.regularity}`)}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        {!stats || stats.avgLengthDays == null ? (
          <p className="text-muted-foreground text-sm">
            {t("cycle.history.none")}
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat
              label={t("cycle.history.avgLength")}
              value={t("cycle.history.days", { count: stats.avgLengthDays })}
            />
            {stats.lengthVariabilityDays != null ? (
              <Stat
                label={t("cycle.history.variability")}
                value={t("cycle.history.daysPlusMinus", {
                  count: stats.lengthVariabilityDays,
                })}
              />
            ) : null}
            {stats.avgPeriodLengthDays != null ? (
              <Stat
                label={t("cycle.history.avgPeriodLength")}
                value={t("cycle.history.days", {
                  count: stats.avgPeriodLengthDays,
                })}
              />
            ) : null}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground mt-0.5 text-lg font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  );
}
