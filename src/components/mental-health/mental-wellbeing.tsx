"use client";

/**
 * v1.25 — opt-in mental-health screener surface (PHQ-9 / GAD-7).
 *
 * Beside mood tracking, never replacing it; framed as a screening self-check,
 * not a diagnosis. The per-item answers stay on the device until submit, the
 * server encrypts them, and only the total trend is persisted as a measurement.
 *
 * SAFETY: this surface is deliberately kept OFF the AI Coach — the shared
 * Coach-launch assessment card is intentionally NOT used here, so a depression /
 * anxiety screen never invites an AI conversation about item content. On a
 * positive PHQ-9 item-9 the server returns a calm, locale-aware crisis-resource
 * set which is rendered immediately below the result.
 *
 * v1.25.3 — this is now the ORCHESTRATOR + landing only; the 387-line monolith
 * split into focused components (`instrument-card`, `check-in-wizard`,
 * `assessment-result`, `assessment-history`, `crisis-card`).
 * The landing follows the card grammar of Vorsorge / Medications: instrument
 * cards (last-result line + Start) + a history card. The disclaimer renders
 * ONLY here (a muted caption) and behind the InfoHint — never while testing.
 *
 * v1.27.6 — the trend chart (and the per-card trend sheet) left this surface;
 * the score curve lives in Insights / Measurements via the PHQ9_SCORE /
 * GAD7_SCORE measurement rows. The landing keeps the calm dated list only.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTranslations } from "@/lib/i18n/context";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { PageHeader } from "@/components/ui/page-header";

import { AssessmentHistory } from "./assessment-history";
import { AssessmentResult } from "./assessment-result";
import { CheckInWizard } from "./check-in-wizard";
import { InstrumentCard } from "./instrument-card";
import type {
  AssessmentRow,
  CreateResponse,
  InstrumentId,
  Phase,
} from "./types";

export function MentalWellbeing() {
  const { t, locale } = useTranslations();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>("choose");
  const [instrument, setInstrument] = useState<InstrumentId>("PHQ9");
  const [result, setResult] = useState<CreateResponse | null>(null);

  const { data: history } = useQuery({
    queryKey: queryKeys.mentalHealthAssessments(),
    queryFn: () =>
      apiGet<{ assessments: AssessmentRow[] }>(
        "/api/mental-health/assessments",
      ),
  });

  const mutation = useMutation({
    mutationFn: (body: unknown) =>
      apiPost<CreateResponse>("/api/mental-health/assessments", body),
    onSuccess: (data) => {
      setResult(data);
      setPhase("result");
      void queryClient.invalidateQueries({
        queryKey: queryKeys.mentalHealthAssessments(),
      });
    },
  });

  // Most-recent assessment per instrument for the landing's "last result" line.
  // The history GET returns rows newest-first, so the first match wins.
  const lastByInstrument = useMemo(() => {
    const map = new Map<InstrumentId, AssessmentRow>();
    for (const row of history?.assessments ?? []) {
      if (!map.has(row.instrument)) map.set(row.instrument, row);
    }
    return map;
  }, [history]);

  function begin(id: InstrumentId) {
    setInstrument(id);
    setResult(null);
    mutation.reset();
    setPhase("form");
  }

  function backToLanding() {
    mutation.reset();
    setPhase("choose");
  }

  function submit(items: number[], functional: number | null) {
    mutation.mutate({
      instrument,
      items,
      ...(functional !== null ? { functionalDifficulty: functional } : {}),
      locale,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {phase === "choose" && (
        <>
          {/* v1.26 — visible page header, consistent with every other module
              (the title was previously sr-only; the description stays). */}
          <PageHeader
            title={t("mentalHealth.pageTitle")}
            description={t("mentalHealth.pageDescription")}
          />

          {/* v1.27.6 — one gentle cadence hint: both instruments ask about
              the last two weeks, so every 2–4 weeks is a sensible rhythm.
              Body prose (foreground), not another muted description line. */}
          <p className="max-w-prose text-sm">
            {t("mentalHealth.pageRhythmHint")}
          </p>

          <section aria-label={t("mentalHealth.choosePrompt")}>
            <h2 className="sr-only">{t("mentalHealth.choosePrompt")}</h2>
            <ul className="grid list-none gap-4 p-0 sm:grid-cols-2">
              {(["PHQ9", "GAD7"] as InstrumentId[]).map((id) => (
                <li key={id} className="contents">
                  <InstrumentCard
                    instrument={id}
                    last={lastByInstrument.get(id)}
                    onStart={() => begin(id)}
                  />
                </li>
              ))}
            </ul>
          </section>

          <AssessmentHistory rows={history?.assessments ?? []} />
        </>
      )}

      {phase === "form" && (
        <CheckInWizard
          instrument={instrument}
          onSubmit={submit}
          onBack={backToLanding}
          isPending={mutation.isPending}
          isError={mutation.isError}
        />
      )}

      {phase === "result" && result && (
        <AssessmentResult
          result={result}
          onTakeAnother={backToLanding}
          onBack={backToLanding}
        />
      )}
    </div>
  );
}
