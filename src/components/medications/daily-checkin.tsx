"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, ClipboardCheck, ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { MedicationSideEffectEntry } from "@/generated/prisma/client";
import {
  SIDE_EFFECT_SEVERITY_LADDER,
  severityLikertLabel,
} from "@/lib/medications/side-effects/taxonomy";
import { profileForTreatmentClass } from "@/lib/medications/profiles/registry";
import type {
  DrugProfile,
  DrugProfileTargetSymptom,
} from "@/lib/medications/profiles/types";
import type {
  CustomMetricDto,
  CustomMetricListResponse,
} from "@/components/custom-metrics/types";

/**
 * Stage B — the daily guided medication check-in ("interview").
 *
 * A quiet two-step sheet driven by the drug profile: (1) which of the drug's
 * side effects you had today + how strongly, (2) how your target symptoms were
 * today. It writes through the EXISTING stores — a `MedicationSideEffect` row
 * per reported effect and a `CustomMetricEntry` per rated symptom — so the
 * timeline + the Wirkung overlay pick the data up with no new backend. The
 * target-symptom custom metrics are seeded from the profile on first submit
 * (idempotent by name), so the symptoms also become pinnable efficacy targets.
 *
 * Strictly descriptive: it records what the user reports and never renders a
 * "good/bad" verdict (CLAUDE.md §1).
 */

interface DailyCheckinProps {
  medicationId: string;
  /** `Medication.treatmentClass` — selects the drug profile. */
  treatmentClass: string;
}

const RATING_SCALE = { min: 1, max: 10 } as const;

function symptomLabel(
  symptom: DrugProfileTargetSymptom,
  locale: string,
): string {
  return locale === "de" ? symptom.labelDe : symptom.labelEn;
}

/** SCREAMING_SNAKE side-effect entry → its camelCase i18n leaf. */
function entryI18nKey(entry: MedicationSideEffectEntry): string {
  return entry
    .toLowerCase()
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function DailyCheckin({
  medicationId,
  treatmentClass,
}: DailyCheckinProps) {
  const { t, locale } = useTranslations();
  const queryClient = useQueryClient();

  const profile = profileForTreatmentClass(treatmentClass);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  // entry -> severity (1..5); absence from the map means "not reported today".
  const [severities, setSeverities] = useState<
    Partial<Record<MedicationSideEffectEntry, number>>
  >({});
  // symptom key -> rating (1..10); absence means "not rated".
  const [ratings, setRatings] = useState<Record<string, number>>({});

  // The user's custom-metric catalog, so we can find-or-create the symptom
  // metrics by name. Only fetched while the sheet is open.
  const { data: metricList } = useQuery({
    queryKey: queryKeys.customMetrics(),
    queryFn: () => apiGet<CustomMetricListResponse>("/api/custom-metrics"),
    enabled: open,
    staleTime: 30_000,
  });

  const submit = useMutation({
    mutationFn: async (p: DrugProfile) => {
      // 1) One side-effect row per reported effect.
      for (const [entry, severity] of Object.entries(severities)) {
        if (!severity) continue;
        await apiPost(`/api/medications/${medicationId}/side-effects`, {
          entry,
          severity,
        });
      }
      // 2) One custom-metric entry per rated symptom (metric seeded on demand).
      const existing = new Map(
        (metricList?.customMetrics ?? []).map((m) => [m.name, m.id]),
      );
      const now = new Date().toISOString();
      for (const symptom of p.targetSymptoms) {
        const value = ratings[symptom.key];
        if (value === undefined) continue;
        const name = symptomLabel(symptom, locale);
        let id = existing.get(name);
        if (!id) {
          const created = await apiPost<CustomMetricDto>(
            "/api/custom-metrics",
            {
              name,
              unit: `${RATING_SCALE.min}–${RATING_SCALE.max}`,
              targetLow: RATING_SCALE.min,
              targetHigh: RATING_SCALE.max,
              decimals: 0,
            },
          );
          id = created.id;
          existing.set(name, id);
        }
        await apiPost(`/api/custom-metrics/${id}/entries`, {
          value,
          measuredAt: now,
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.medicationSideEffects(medicationId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.customMetrics(),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.medicationEfficacy(medicationId),
      });
      toast.success(t("medications.dailyCheckin.saved"));
      reset();
      setOpen(false);
    },
    onError: () => {
      toast.error(t("medications.dailyCheckin.error"));
    },
  });

  function reset() {
    setStep(1);
    setSeverities({});
    setRatings({});
  }

  if (!profile) return null;

  const reportedCount = Object.values(severities).filter(Boolean).length;
  const ratedCount = Object.keys(ratings).length;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-slot="daily-checkin-cta"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <ClipboardCheck className="h-3.5 w-3.5" />
        {t("medications.dailyCheckin.cta")}
      </Button>

      <ResponsiveSheet
        open={open}
        onOpenChange={setOpen}
        title={t("medications.dailyCheckin.title")}
        description={
          step === 1
            ? t("medications.dailyCheckin.sideEffectsPrompt")
            : t("medications.dailyCheckin.symptomsPrompt")
        }
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            {step === 2 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep(1)}
                disabled={submit.isPending}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {t("medications.dailyCheckin.back")}
              </Button>
            ) : (
              <span />
            )}
            {step === 1 ? (
              <Button type="button" onClick={() => setStep(2)}>
                {t("medications.dailyCheckin.next")}
              </Button>
            ) : (
              <Button
                type="button"
                disabled={submit.isPending}
                onClick={() => submit.mutate(profile)}
              >
                {submit.isPending && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                )}
                {t("medications.dailyCheckin.submit")}
              </Button>
            )}
          </div>
        }
      >
        {step === 1 ? (
          <div className="space-y-3" data-slot="daily-checkin-side-effects">
            <p className="text-muted-foreground text-xs">
              {t("medications.dailyCheckin.sideEffectsHint")}
            </p>
            <ul className="space-y-1.5">
              {profile.sideEffects.map(({ entry }) => {
                const current = severities[entry];
                return (
                  <li
                    key={entry}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md px-1 py-1"
                  >
                    <span className="text-foreground text-sm">
                      {t(
                        `medications.sideEffects.entries.${entryI18nKey(entry)}`,
                      )}
                    </span>
                    <div
                      className="flex flex-wrap gap-1"
                      role="radiogroup"
                      aria-label={t(
                        `medications.sideEffects.entries.${entryI18nKey(entry)}`,
                      )}
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={current === undefined}
                        onClick={() =>
                          setSeverities((s) => {
                            const next = { ...s };
                            delete next[entry];
                            return next;
                          })
                        }
                        className={`min-h-8 rounded-md border px-2 text-xs transition-colors ${
                          current === undefined
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        {t("medications.dailyCheckin.none")}
                      </button>
                      {SIDE_EFFECT_SEVERITY_LADDER.map((label, idx) => {
                        const value = idx + 1;
                        const selected = current === value;
                        return (
                          <button
                            type="button"
                            key={label}
                            role="radio"
                            aria-checked={selected}
                            title={t(
                              `medications.sideEffects.severity.${severityLikertLabel(
                                value as 1 | 2 | 3 | 4 | 5,
                              )}`,
                            )}
                            onClick={() =>
                              setSeverities((s) => ({ ...s, [entry]: value }))
                            }
                            className={`min-h-8 min-w-8 rounded-md border text-xs transition-colors ${
                              selected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-background text-foreground hover:bg-muted"
                            }`}
                          >
                            {value}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="text-muted-foreground text-right text-xs">
              {t("medications.dailyCheckin.reportedCount", {
                count: reportedCount,
              })}
            </p>
          </div>
        ) : (
          <div className="space-y-3" data-slot="daily-checkin-symptoms">
            <p className="text-muted-foreground text-xs">
              {t("medications.dailyCheckin.symptomsHint")}
            </p>
            <ul className="space-y-3">
              {profile.targetSymptoms.map((symptom) => (
                <li key={symptom.key} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-foreground text-sm">
                      {symptomLabel(symptom, locale)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {symptom.higherIsBetter
                        ? t("medications.dailyCheckin.dirHigher")
                        : t("medications.dailyCheckin.dirLower")}
                    </span>
                  </div>
                  <div
                    className="flex flex-wrap gap-1"
                    role="radiogroup"
                    aria-label={symptomLabel(symptom, locale)}
                  >
                    {Array.from(
                      { length: RATING_SCALE.max - RATING_SCALE.min + 1 },
                      (_, i) => RATING_SCALE.min + i,
                    ).map((value) => {
                      const selected = ratings[symptom.key] === value;
                      return (
                        <button
                          type="button"
                          key={value}
                          role="radio"
                          aria-checked={selected}
                          onClick={() =>
                            setRatings((r) => ({ ...r, [symptom.key]: value }))
                          }
                          className={`min-h-8 min-w-8 rounded-md border text-xs transition-colors ${
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background text-foreground hover:bg-muted"
                          }`}
                        >
                          {value}
                        </button>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-right text-xs">
              {t("medications.dailyCheckin.ratedCount", { count: ratedCount })}
            </p>
          </div>
        )}
      </ResponsiveSheet>
    </>
  );
}
