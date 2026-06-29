"use client";

/**
 * v1.25.3 — one neutral card per instrument on the landing.
 *
 * Mirrors the Vorsorge / medication card grammar: a header (title + sub),
 * a discreet "last result" line when history exists (band badge + relative
 * date), and a single bottom-pinned Start action. The surface stays NEUTRAL
 * regardless of the last band — no severity tint (house rule: status reads
 * through a discreet badge only).
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

import type { AssessmentRow, InstrumentId } from "./types";

function lower(id: InstrumentId): "phq9" | "gad7" {
  return id === "PHQ9" ? "phq9" : "gad7";
}

export function InstrumentCard({
  instrument,
  last,
  onStart,
}: {
  instrument: InstrumentId;
  /** Most-recent assessment for this instrument, or undefined when none yet. */
  last: AssessmentRow | undefined;
  onStart: () => void;
}) {
  const { t } = useTranslations();
  const { date: formatDate } = useFormatters();
  const key = lower(instrument);

  return (
    <Card className="h-full gap-3" data-slot="instrument-card">
      <CardContent className="flex h-full flex-col gap-4 p-4">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            {t(`mentalHealth.instrument.${key}`)}
          </span>
          <span className="text-muted-foreground text-xs">
            {t(`mentalHealth.instrumentSub.${key}`)}
          </span>
        </div>

        <div className="text-muted-foreground min-h-5 text-xs">
          {last ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <span>{t("mentalHealth.lastResult")}</span>
              <Badge variant="secondary">
                {t(`mentalHealth.band.${instrument}.${last.severityBand}`)}
              </Badge>
              <span>{formatDate(last.takenAt)}</span>
            </span>
          ) : (
            <span>{t("mentalHealth.noResultYet")}</span>
          )}
        </div>

        <div className="mt-auto pt-0">
          <Button type="button" className="min-h-11 w-full" onClick={onStart}>
            {t("mentalHealth.start")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
