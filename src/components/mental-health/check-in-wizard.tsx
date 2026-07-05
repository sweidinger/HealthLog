"use client";

/**
 * v1.25.3 — one-question-at-a-time check-in, rendered INLINE on the page
 * (not a modal), because here the page *is* the surface.
 *
 * v1.27.6 — slimmed to questions only. The question-overview strip (the
 * dot/jump row borrowed from the medication wizard) and the "N of N
 * answered" review interstitial are gone: a screening is a quiet, linear
 * moment, not a form to audit. The Back button stays; a small "3 / 9"
 * caption keeps orientation without turning progress into a scoreboard.
 * Answering the last question arms the submit directly — the next thing
 * the user sees is the dignified result view.
 *
 * Header: instrument title + ONE standardized explanation line, NO
 * disclaimer (§2 — the "voluntary self-test, not a diagnosis" disclaimer
 * renders only on the landing, never while taking the test).
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { INSTRUMENTS } from "@/lib/mental-health/instruments";

import {
  isComplete,
  isLastStep,
  nextStep,
  prevStep,
  UNANSWERED,
} from "./check-in-nav";
import type { InstrumentId } from "./types";

const SCALE = [0, 1, 2, 3] as const;

function lower(id: InstrumentId): "phq9" | "gad7" {
  return id === "PHQ9" ? "phq9" : "gad7";
}

export function CheckInWizard({
  instrument,
  onSubmit,
  onBack,
  isPending,
  isError,
}: {
  instrument: InstrumentId;
  /** Submit the completed check-in. */
  onSubmit: (items: number[]) => void;
  /** Return to the landing (abandons the in-progress check-in). */
  onBack: () => void;
  isPending: boolean;
  isError: boolean;
}) {
  const { t } = useTranslations();
  const key = lower(instrument);
  const itemCount = INSTRUMENTS[instrument].itemCount;

  const [step, setStep] = useState(1);
  const [items, setItems] = useState<number[]>(() =>
    Array(itemCount).fill(UNANSWERED),
  );

  const onLast = isLastStep(step, itemCount);
  const questionIndex = step - 1; // 0-based item index for the current question
  const complete = isComplete(items);

  // a11y: announce each step by moving focus to its heading (the question
  // text). Mirrors the medication dialog's per-step title focus so a
  // keyboard / screen-reader user hears the new question after an
  // auto-advance, not silence.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: false });
  }, [step]);

  function selectAnswer(value: number) {
    setItems((prev) => {
      const next = [...prev];
      next[questionIndex] = value;
      return next;
    });
    // Forward-on-select: advance to the next question. On the last question
    // the selection stays visible and the footer submit arms — submitting is
    // a deliberate second tap, never a side effect of answering.
    if (!onLast) setStep((s) => nextStep(s, itemCount));
  }

  return (
    <section
      className="flex flex-col gap-5"
      data-slot="mental-health-check-in"
      aria-busy={isPending || undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 w-fit"
        onClick={onBack}
        data-slot="check-in-back-to-landing"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("mentalHealth.backToList")}
      </Button>

      {/* In-test header — instrument title + ONE standardized explanation line.
          No disclaimer here (§2); the landing carries it. */}
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">
          {t(`mentalHealth.instrument.${key}`)}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t(`mentalHealth.instrumentDescription.${key}`)}
        </p>
      </header>

      <Card className="gap-0 p-0">
        <CardContent className="flex flex-col gap-5 p-4 sm:p-6">
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground text-xs">
              {t("mentalHealth.progress", {
                current: step,
                total: itemCount,
              })}
            </p>
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="scroll-mt-4 text-base font-medium outline-none"
            >
              {t(`mentalHealth.items.${key}.${step}`)}
            </h2>
            <div
              className="flex flex-col gap-2"
              role="group"
              aria-label={t(`mentalHealth.items.${key}.${step}`)}
            >
              {SCALE.map((v) => (
                <Button
                  key={v}
                  type="button"
                  // 44px touch-target floor (WCAG 2.5.5).
                  className="min-h-11 justify-start"
                  variant={items[questionIndex] === v ? "default" : "outline"}
                  aria-pressed={items[questionIndex] === v}
                  onClick={() => selectAnswer(v)}
                  disabled={isPending}
                >
                  {t(`mentalHealth.options.${v}`)}
                </Button>
              ))}
            </div>

            {isError && (
              <p className="text-destructive text-sm" role="alert">
                {t("mentalHealth.error")}
              </p>
            )}
          </div>
        </CardContent>

        <div className="border-border/70 flex items-center justify-between gap-2 border-t p-4 sm:p-6">
          <Button
            type="button"
            variant="ghost"
            className="h-11"
            onClick={() => setStep((s) => prevStep(s))}
            disabled={step === 1 || isPending}
            data-slot="check-in-back"
          >
            {t("mentalHealth.back")}
          </Button>
          {!onLast ? (
            <Button
              type="button"
              className="h-11"
              onClick={() => setStep((s) => nextStep(s, itemCount))}
              disabled={items[questionIndex] < 0}
              data-slot="check-in-next"
            >
              {t("mentalHealth.next")}
            </Button>
          ) : (
            <Button
              type="button"
              className="h-11"
              onClick={() => onSubmit(items)}
              disabled={!complete || isPending}
              aria-busy={isPending || undefined}
              data-slot="check-in-submit"
            >
              {isPending
                ? t("mentalHealth.submitting")
                : t("mentalHealth.submit")}
            </Button>
          )}
        </div>
      </Card>
    </section>
  );
}
