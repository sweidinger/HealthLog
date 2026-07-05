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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { relativeCalendarDate } from "@/lib/i18n/relative-time";

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
  const title = t(`mentalHealth.instrument.${key}`);

  return (
    <Card className="h-full gap-3" data-slot="instrument-card">
      <CardContent className="flex h-full flex-col space-y-3.5 p-4">
        {/* v1.27.6 — the card body is no longer a trend-detail target (the
            trend chart left this surface); the card informs, the Start button
            below is the single action. */}
        <div className="flex flex-1 flex-col gap-3.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-lg leading-none font-semibold">{title}</span>
            <span className="text-muted-foreground text-xs">
              {t(`mentalHealth.instrumentSub.${key}`)}
            </span>
          </div>

          {/* Last-test line in the medication-card grammar: label left, the
              relative day (today / yesterday / date) right-aligned. */}
          <div className="text-muted-foreground flex min-h-5 items-center justify-between gap-2 text-xs">
            {last ? (
              <>
                <span>{t("mentalHealth.lastResult")}</span>
                <span className="shrink-0">
                  {relativeCalendarDate(last.takenAt, t, formatDate)}
                </span>
              </>
            ) : (
              <span>{t("mentalHealth.noResultYet")}</span>
            )}
          </div>
        </div>

        <div className="pt-0">
          <Button type="button" className="min-h-11 w-full" onClick={onStart}>
            {t("mentalHealth.start")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
