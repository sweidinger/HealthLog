"use client";

/**
 * v1.25.3 — one neutral card per instrument on the landing.
 *
 * v1.27.6 — rebuilt onto the shared med-/Vorsorge card anatomy so the two
 * test cards read exactly like their peers: `MedicationCardHeader` (bold
 * name + outline category badge), a label/value block in the next-last
 * grammar ("last test" → relative day, "last result" → score + band word),
 * and a single bottom-pinned Start action. The surface stays NEUTRAL
 * regardless of the last band — no severity tint (house rule: status reads
 * through discreet text only, never a card wash).
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MedicationCardHeader } from "@/components/medications/medication-card-header";
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
    <Card className="h-full gap-3 md:gap-3" data-slot="instrument-card">
      <MedicationCardHeader
        name={title}
        dose=""
        categoryLabel={t(`mentalHealth.instrumentSub.${key}`)}
      />
      <CardContent className="flex h-full flex-col space-y-3.5">
        {/* Label/value block in the Vorsorge card's next-last grammar. With
            no history yet, one calm line replaces the pair — no dashes
            pretending a value exists. */}
        {last ? (
          <div className="min-h-[2.75rem] space-y-1.5 text-sm">
            <div className="text-muted-foreground flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-shrink truncate font-medium">
                {t("mentalHealth.lastResult")}
              </span>
              <span className="text-foreground text-right">
                {relativeCalendarDate(last.takenAt, t, formatDate)}
              </span>
            </div>
            <div className="text-muted-foreground flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-shrink truncate font-medium">
                {t("mentalHealth.lastScore")}
              </span>
              <span
                className="text-foreground text-right"
                data-slot="instrument-card-last-score"
              >
                {last.totalScore}
                {" · "}
                {t(`mentalHealth.band.${last.instrument}.${last.severityBand}`)}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-muted-foreground flex min-h-[2.75rem] items-center text-sm">
            {t("mentalHealth.noResultYet")}
          </div>
        )}

        {/* Bottom-pinned single primary action — the med-/Vorsorge card slot. */}
        <div className="mt-auto pt-0">
          <Button type="button" className="min-h-11 w-full" onClick={onStart}>
            {t("mentalHealth.start")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
