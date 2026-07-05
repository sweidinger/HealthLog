"use client";

/**
 * v1.25.3 — one neutral card per instrument on the landing.
 *
 * v1.27.6 — rebuilt onto the shared med-/Vorsorge card anatomy so the test
 * cards read exactly like their peers: `MedicationCardHeader` (bold
 * name + outline category badge), a label/value block in the next-last
 * grammar ("last test" → relative day, "last result" → score + band word),
 * and a single bottom-pinned Start action. The surface stays NEUTRAL
 * regardless of the last band — no severity tint (house rule: status reads
 * through discreet text only, never a card wash).
 *
 * v1.27.9 — the card generalises over the four-instrument registry and
 * carries the instrument's required attribution/licence line as a small
 * factual footer (WHO CC BY-NC-SA citation for the WHO-5, the Sleepio
 * CC BY-NC citation for the SCI, the Pfizer grant for PHQ/GAD). A locale
 * without validated item wording additionally gets the honest
 * "validated in English" note. The card BODY (header + last-result block)
 * opens the per-instrument detail — the Vorsorge-/med-card interaction —
 * while the bottom-pinned Start button stays a separate, non-overlapping
 * action.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MedicationCardHeader } from "@/components/medications/medication-card-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { relativeCalendarDate } from "@/lib/i18n/relative-time";
import {
  INSTRUMENTS,
  hasValidatedItems,
} from "@/lib/mental-health/instruments";

import type { AssessmentRow, InstrumentId } from "./types";

export function InstrumentCard({
  instrument,
  last,
  onStart,
  onOpenDetail,
}: {
  instrument: InstrumentId;
  /** Most-recent assessment for this instrument, or undefined when none yet. */
  last: AssessmentRow | undefined;
  onStart: () => void;
  /**
   * Open this instrument's detail (last score + band, trend chart, dated
   * history). The card body is the target; Start stays separate.
   */
  onOpenDetail: () => void;
}) {
  const { t, locale } = useTranslations();
  const { date: formatDate } = useFormatters();
  const def = INSTRUMENTS[instrument];
  const key = def.i18nKey;
  const title = t(`mentalHealth.instrument.${key}`);

  return (
    <Card className="h-full gap-3 md:gap-3" data-slot="instrument-card">
      {/* Body is the detail target: clicking the header / last-result block
          opens this instrument's detail (chart + dated history), like a
          medication card. The Start button below stays a separate action. */}
      <button
        type="button"
        onClick={onOpenDetail}
        data-slot="instrument-card-open"
        aria-label={`${title} — ${t("mentalHealth.openDetail")}`}
        className="focus-visible:ring-ring/60 hover:bg-accent/40 flex cursor-pointer flex-col gap-3 rounded-t-xl text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <MedicationCardHeader
          name={title}
          dose=""
          categoryLabel={t(`mentalHealth.instrumentSub.${key}`)}
        />

        {/* Label/value block in the Vorsorge card's next-last grammar. With
            no history yet, one calm line replaces the pair — no dashes
            pretending a value exists. */}
        {last ? (
          <div className="min-h-[2.75rem] w-full space-y-1.5 px-4 text-sm md:px-6">
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
          <div className="text-muted-foreground flex min-h-[2.75rem] items-center px-4 text-sm md:px-6">
            {t("mentalHealth.noResultYet")}
          </div>
        )}
      </button>

      <CardContent className="flex h-full flex-col">
        {/* Bottom-pinned single primary action — the med-/Vorsorge card slot. */}
        <div className="mt-auto space-y-2 pt-0">
          <Button type="button" className="min-h-11 w-full" onClick={onStart}>
            {t("mentalHealth.start")}
          </Button>
          {/* Required attribution — factual and unobtrusive; identical slot on
              every card so the grid stays symmetric. */}
          <p
            className="text-muted-foreground text-xs leading-snug"
            data-slot="instrument-card-attribution"
          >
            {!hasValidatedItems(instrument, locale) && (
              <>{t("mentalHealth.validatedInEnglishNote")} </>
            )}
            {def.attribution}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
