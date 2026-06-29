"use client";

/**
 * v1.25.3 — one-question-at-a-time check-in.
 *
 * Replaces the all-questions-at-once `<ol>` wall with a linear stepper that
 * reuses the medication wizard's presentational `WizardStepper` (the dot row +
 * "Question 3 of 9" caption) and its Back/Next footer grammar — rendered INLINE
 * on the page (not a modal), because here the page *is* the surface. The step
 * navigation lives in `check-in-nav.ts` (pure, linear: backward always allowed,
 * never skip ahead to an unanswered question).
 *
 * Header: instrument title + ONE standardized explanation line, NO disclaimer
 * (§2 — the "voluntary self-test, not a diagnosis" disclaimer renders only on
 * the landing + behind the InfoHint, never while taking the test). The optional
 * functional-difficulty control folds into the review step.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WizardStepper } from "@/components/medications/wizard/wizard-stepper";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { INSTRUMENTS } from "@/lib/mental-health/instruments";

import {
  UNANSWERED,
  answeredCount,
  buildStepList,
  isComplete,
  isReviewStep,
  nextStep,
  prevStep,
  reachableUntilIndex,
} from "./check-in-nav";
import type { InstrumentId } from "./types";

const SCALE = [0, 1, 2, 3] as const;
const FUNCTIONAL = [0, 1, 2, 3] as const;

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
  /** Submit the completed check-in. `functional` is null when unanswered. */
  onSubmit: (items: number[], functional: number | null) => void;
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
  const [functional, setFunctional] = useState<number | null>(null);

  const stepList = buildStepList(itemCount);
  const onReview = isReviewStep(step, itemCount);
  const questionIndex = step - 1; // 0-based item index for a question step
  const complete = isComplete(items);
  const reachableUntil = reachableUntilIndex(items);

  // a11y: announce each step by moving focus to its heading (the question text
  // / the review title). Mirrors the medication dialog's per-step title focus
  // so a keyboard / screen-reader user hears the new question after an
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
    // Forward-on-select: advance to the next question, or onto the review step
    // from the last question. The footer Next is the redundant keyboard path.
    setStep((s) => nextStep(s, itemCount));
  }

  const srLabel = onReview
    ? t("mentalHealth.review.title")
    : t("mentalHealth.questionAria", { current: step, total: itemCount });

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
          No disclaimer here (§2); the (i) tooltip on the landing carries it. */}
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">
          {t(`mentalHealth.instrument.${key}`)}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t(`mentalHealth.instrumentDescription.${key}`)}
        </p>
      </header>

      <Card className="gap-0 p-0">
        <div className="border-border/70 space-y-1.5 border-b p-4 sm:p-6">
          <WizardStepper
            steps={stepList}
            current={step}
            reachableUntil={reachableUntil}
            labels={Object.fromEntries([
              ...Array.from({ length: itemCount }, (_, i) => [
                i + 1,
                String(i + 1),
              ]),
              [itemCount + 1, t("mentalHealth.review.title")],
            ])}
            onJump={(target) => setStep(target)}
            onFirst={() => setStep(1)}
            onLast={() => setStep(itemCount + 1)}
            firstEnabled={step > 1}
            lastEnabled={complete && !onReview}
            firstLabel={t("mentalHealth.jumpFirst")}
            lastLabel={t("mentalHealth.jumpLast")}
            srLabel={srLabel}
          />
        </div>

        <CardContent className="flex flex-col gap-5 p-4 sm:p-6">
          {!onReview ? (
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
                  >
                    {t(`mentalHealth.options.${v}`)}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="scroll-mt-4 text-base font-medium outline-none"
              >
                {t("mentalHealth.review.title")}
              </h2>
              <p className="text-muted-foreground text-sm">
                {t("mentalHealth.review.recap", {
                  answered: answeredCount(items),
                  total: itemCount,
                })}
              </p>

              {/* The optional, unscored functional-difficulty follow-up folds
                  into the review step rather than its own dot (§1). */}
              <div className="border-border/60 flex flex-col gap-2 border-t pt-4">
                <span className="text-sm">
                  {t("mentalHealth.functionalTitle")}
                </span>
                <div
                  className="flex flex-col gap-2"
                  role="group"
                  aria-label={t("mentalHealth.functionalTitle")}
                >
                  {FUNCTIONAL.map((v) => (
                    <Button
                      key={v}
                      type="button"
                      className="min-h-11 justify-start"
                      variant={functional === v ? "default" : "outline"}
                      aria-pressed={functional === v}
                      onClick={() => setFunctional(v)}
                    >
                      {t(`mentalHealth.functional.${v}`)}
                    </Button>
                  ))}
                </div>
              </div>

              {isError && (
                <p className="text-destructive text-sm">
                  {t("mentalHealth.error")}
                </p>
              )}
            </div>
          )}
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
          {!onReview ? (
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
              className={cn("h-11")}
              onClick={() => onSubmit(items, functional)}
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
