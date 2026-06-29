"use client";

/**
 * v1.25.3 — the contained result block: instrument header → result card →
 * crisis card (on a positive PHQ-9 item 9) → required attribution → "take
 * another". Content is unchanged from the v1.25 monolith; it is re-housed as
 * one stack inside the page spine instead of loose top-level sections.
 *
 * SAFETY: the crisis set rides the POST response (`crisis`) on any non-zero
 * item 9 and renders immediately; this surface never invites an AI Coach
 * conversation about item content.
 */
import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { PHQ_GAD_ATTRIBUTION } from "@/lib/mental-health/instruments";

import { CrisisCard } from "./crisis-card";
import type { CreateResponse, InstrumentId } from "./types";

function lower(id: InstrumentId): "phq9" | "gad7" {
  return id === "PHQ9" ? "phq9" : "gad7";
}

export function AssessmentResult({
  result,
  onTakeAnother,
  onBack,
}: {
  result: CreateResponse;
  onTakeAnother: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslations();
  const instrument = result.assessment.instrument;
  const key = lower(instrument);

  // a11y: on submit the wizard unmounts and this view mounts; move focus to the
  // result heading so keyboard / screen-reader users land on the new content
  // rather than being dropped to <body>.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section
      className="flex flex-col gap-4"
      data-slot="mental-health-result"
      aria-live="polite"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 w-fit"
        onClick={onBack}
        data-slot="result-back-to-landing"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("mentalHealth.backToList")}
      </Button>

      <header className="flex flex-col gap-1">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="scroll-mt-4 text-2xl font-semibold outline-none"
        >
          {t(`mentalHealth.instrument.${key}`)}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t(`mentalHealth.instrumentDescription.${key}`)}
        </p>
      </header>

      <p className="text-muted-foreground text-xs" role="status">
        {t("mentalHealth.saved")}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>{t("mentalHealth.result.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground">
              {t("mentalHealth.result.totalLabel")}
            </span>
            <span className="text-2xl font-semibold">
              {result.assessment.totalScore}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground">
              {t("mentalHealth.result.bandLabel")}
            </span>
            <span className="font-medium">
              {t(
                `mentalHealth.band.${result.assessment.instrument}.${result.assessment.severityBand}`,
              )}
            </span>
          </div>
          {result.assessment.totalScore >= result.actionThreshold && (
            <p className="text-muted-foreground bg-muted/40 rounded-md p-3 text-xs">
              {t("mentalHealth.considerProfessional")}
            </p>
          )}
        </CardContent>
      </Card>

      {result.crisis && <CrisisCard crisis={result.crisis} />}

      <p className="text-muted-foreground text-[11px] leading-snug">
        <span className="font-medium">
          {t("mentalHealth.attributionLabel")}:
        </span>{" "}
        {PHQ_GAD_ATTRIBUTION}
      </p>

      <Button variant="outline" onClick={onTakeAnother}>
        {t("mentalHealth.result.takeAnother")}
      </Button>
    </section>
  );
}
