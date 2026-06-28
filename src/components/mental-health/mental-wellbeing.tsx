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
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  INSTRUMENTS,
  PHQ_GAD_ATTRIBUTION,
  type InstrumentId,
} from "@/lib/mental-health/instruments";

type Phase = "choose" | "form" | "result";

interface AssessmentRow {
  id: string;
  instrument: InstrumentId;
  totalScore: number;
  severityBand: string;
  item9Flagged: boolean;
  takenAt: string;
}

interface CrisisSet {
  emergencyNumber: string;
  resources: { id: string; contacts: string[] }[];
}

interface CreateResponse {
  assessment: AssessmentRow;
  actionThreshold: number;
  crisis: CrisisSet | null;
}

const SCALE = [0, 1, 2, 3] as const;
const FUNCTIONAL = [0, 1, 2, 3] as const;

export function MentalWellbeing() {
  const { t, locale } = useTranslations();
  const { date: formatDate } = useFormatters();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>("choose");
  const [instrument, setInstrument] = useState<InstrumentId>("PHQ9");
  const [items, setItems] = useState<number[]>([]);
  const [functional, setFunctional] = useState<number | null>(null);
  const [result, setResult] = useState<CreateResponse | null>(null);

  const lower = (id: InstrumentId) => (id === "PHQ9" ? "phq9" : "gad7");

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

  function begin(id: InstrumentId) {
    setInstrument(id);
    setItems(Array(INSTRUMENTS[id].itemCount).fill(-1));
    setFunctional(null);
    setResult(null);
    setPhase("form");
  }

  const complete = items.length > 0 && items.every((v) => v >= 0);

  function submit() {
    if (!complete) return;
    mutation.mutate({
      instrument,
      items,
      ...(functional !== null ? { functionalDifficulty: functional } : {}),
      locale,
    });
  }

  const itemCount = INSTRUMENTS[instrument].itemCount;
  const itemIndexes = useMemo(
    () => Array.from({ length: itemCount }, (_, i) => i),
    [itemCount],
  );

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">
          {t("mentalHealth.pageTitle")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("mentalHealth.pageDescription")}
        </p>
        <p className="text-muted-foreground border-border/60 bg-muted/40 rounded-md border p-3 text-xs">
          {t("mentalHealth.disclaimer")}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("mentalHealth.optInNote")}
        </p>
      </header>

      {phase === "choose" && (
        <section
          className="flex flex-col gap-3"
          aria-label={t("mentalHealth.choosePrompt")}
        >
          <h2 className="text-sm font-medium">
            {t("mentalHealth.choosePrompt")}
          </h2>
          {(["PHQ9", "GAD7"] as InstrumentId[]).map((id) => (
            <Card key={id}>
              <CardContent className="flex items-center justify-between gap-4 p-4">
                <div className="flex flex-col">
                  <span className="font-medium">
                    {t(`mentalHealth.instrument.${lower(id)}`)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {t(`mentalHealth.instrumentSub.${lower(id)}`)}
                  </span>
                </div>
                <Button onClick={() => begin(id)}>
                  {t("mentalHealth.start")}
                </Button>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      {phase === "form" && (
        <section className="flex flex-col gap-5">
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPhase("choose")}
            >
              {t("mentalHealth.back")}
            </Button>
            <span className="text-sm font-medium">
              {t(`mentalHealth.instrument.${lower(instrument)}`)}
            </span>
          </div>
          <p className="text-sm">{t("mentalHealth.stem")}</p>

          <ol className="flex flex-col gap-5">
            {itemIndexes.map((i) => (
              <li key={i} className="flex flex-col gap-2">
                <span className="text-sm">
                  {i + 1}.{" "}
                  {t(`mentalHealth.items.${lower(instrument)}.${i + 1}`)}
                </span>
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label={t(
                    `mentalHealth.items.${lower(instrument)}.${i + 1}`,
                  )}
                >
                  {SCALE.map((v) => (
                    <Button
                      key={v}
                      type="button"
                      size="sm"
                      variant={items[i] === v ? "default" : "outline"}
                      aria-pressed={items[i] === v}
                      onClick={() =>
                        setItems((prev) => {
                          const next = [...prev];
                          next[i] = v;
                          return next;
                        })
                      }
                    >
                      {t(`mentalHealth.options.${v}`)}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ol>

          <div className="border-border/60 flex flex-col gap-2 border-t pt-4">
            <span className="text-sm">{t("mentalHealth.functionalTitle")}</span>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label={t("mentalHealth.functionalTitle")}
            >
              {FUNCTIONAL.map((v) => (
                <Button
                  key={v}
                  type="button"
                  size="sm"
                  variant={functional === v ? "default" : "outline"}
                  aria-pressed={functional === v}
                  onClick={() => setFunctional(v)}
                >
                  {t(`mentalHealth.functional.${v}`)}
                </Button>
              ))}
            </div>
          </div>

          {mutation.isError && (
            <p className="text-destructive text-sm">
              {t("mentalHealth.error")}
            </p>
          )}
          <Button onClick={submit} disabled={!complete || mutation.isPending}>
            {mutation.isPending
              ? t("mentalHealth.submitting")
              : t("mentalHealth.submit")}
          </Button>
        </section>
      )}

      {phase === "result" && result && (
        <section className="flex flex-col gap-4">
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

          {result.crisis && (
            <Card className="border-amber-400/50">
              <CardHeader>
                <CardTitle className="text-base">
                  {t("mentalHealth.crisis.title")}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <p>{t("mentalHealth.crisis.intro")}</p>
                <p className="font-medium">
                  {t("mentalHealth.crisis.ifDanger", {
                    emergency: result.crisis.emergencyNumber,
                  })}
                </p>
                <div className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-xs font-medium">
                    {t("mentalHealth.crisis.resourcesTitle")}
                  </span>
                  <ul className="flex flex-col gap-2">
                    {result.crisis.resources.map((r) => (
                      <li key={r.id} className="flex flex-col">
                        <span className="font-medium">
                          {t(`mentalHealth.crisisResource.${r.id}.name`)}
                        </span>
                        <span className="text-muted-foreground">
                          {r.contacts.join(" · ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          )}

          <p className="text-muted-foreground text-[11px] leading-snug">
            <span className="font-medium">
              {t("mentalHealth.attributionLabel")}:
            </span>{" "}
            {PHQ_GAD_ATTRIBUTION}
          </p>

          <Button variant="outline" onClick={() => setPhase("choose")}>
            {t("mentalHealth.result.takeAnother")}
          </Button>
        </section>
      )}

      <section className="border-border/60 flex flex-col gap-2 border-t pt-4">
        <h2 className="text-sm font-medium">
          {t("mentalHealth.history.title")}
        </h2>
        {!history || history.assessments.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("mentalHealth.history.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {history.assessments.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between text-sm"
              >
                <span>
                  {t(`mentalHealth.instrument.${lower(row.instrument)}`)}
                </span>
                <span className="text-muted-foreground">
                  {t(`mentalHealth.band.${row.instrument}.${row.severityBand}`)}{" "}
                  · {formatDate(row.takenAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
