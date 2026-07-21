"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { DateField } from "@/components/ui/date-field";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { apiDelete, apiGet, apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

/**
 * Fork ADHS Stage C — the titration ("Eindosierung") plan-builder.
 *
 * Lets the user RECORD the dose-escalation plan their prescriber gave them as
 * future-dated `MedicationDoseChange` rows, which the `TitrationTimeline` then
 * renders as completed + planned steps. It writes through the existing create
 * path (`POST /api/medications/[id]/glp1` with a `doseChange` body) and the
 * Stage-C delete path, so no schema change.
 *
 * SAFETY (CLAUDE.md §1 — non-negotiable): this is pure data-entry that MIRRORS
 * the prescription. It never suggests, defaults, or computes a dose. Every
 * dose value is typed by the user. The only convenience is spacing the STEP
 * DATES by a chosen interval (weekly / bi-weekly) — a scheduling aid, not a
 * medical one; the doses are always explicit and empty until entered.
 */
interface DoseChange {
  id: string;
  effectiveFrom: string;
  doseValue: number;
  doseUnit: string;
  note?: string | null;
}
interface Glp1DetailsResponse {
  doseChanges: DoseChange[];
}

interface TitrationPlanBuilderProps {
  medicationId: string;
}

/** Add `days` to an ISO `yyyy-MM-dd` date, returning `yyyy-MM-dd` (UTC math). */
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** The calendar date of step `index`, spaced `intervalDays` from `startIso`. */
export function stepDateIso(
  startIso: string,
  index: number,
  intervalDays: number,
): string {
  return addDaysIso(startIso, index * intervalDays);
}

/**
 * Parse a user-typed dose to a positive finite number (accepts a comma decimal
 * separator), or null when blank / invalid. NEVER supplies a value of its own.
 */
export function parseDoseValue(raw: string): number | null {
  const n = Number(String(raw).replace(",", ".").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** ISO `yyyy-MM-dd` → an offset datetime at noon UTC (keeps the calendar day). */
export function isoDateToEffectiveFrom(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toISOString();
}

const INTERVAL_OPTIONS = [7, 14] as const;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function TitrationPlanBuilder({
  medicationId,
}: TitrationPlanBuilderProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState("mg");
  const [startDate, setStartDate] = useState<string>(todayIso());
  const [intervalDays, setIntervalDays] = useState<number>(7);
  // One string per planned step; absence of a value means "not entered yet".
  const [doses, setDoses] = useState<string[]>([""]);

  const { data: details } = useQuery<Glp1DetailsResponse | null>({
    queryKey: queryKeys.medicationGlp1Details(medicationId),
    queryFn: async () => {
      try {
        return await apiGet<Glp1DetailsResponse>(
          `/api/medications/${medicationId}/glp1`,
        );
      } catch {
        return null;
      }
    },
    enabled: open,
    staleTime: 60 * 1000,
  });

  const existing = useMemo(
    () =>
      [...(details?.doseChanges ?? [])].sort(
        (a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom),
      ),
    [details],
  );

  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.medicationGlp1Details(medicationId),
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      const trimmedUnit = unit.trim() || "mg";
      const rows = doses
        .map((raw, i) => ({ value: parseDoseValue(raw), index: i }))
        .filter((r): r is { value: number; index: number } => r.value !== null);
      if (rows.length === 0) {
        throw new Error("no-valid-step");
      }
      for (const row of rows) {
        await apiPost(`/api/medications/${medicationId}/glp1`, {
          doseChange: {
            effectiveFrom: isoDateToEffectiveFrom(
              stepDateIso(startDate, row.index, intervalDays),
            ),
            doseValue: row.value,
            doseUnit: trimmedUnit,
          },
        });
      }
      return rows.length;
    },
    onSuccess: () => {
      invalidate();
      toast.success(t("medications.titration.builder.saved"));
      setDoses([""]);
    },
    onError: (err) => {
      toast.error(
        err instanceof Error && err.message === "no-valid-step"
          ? t("medications.titration.builder.noStepError")
          : t("medications.titration.builder.saveError"),
      );
    },
  });

  const remove = useMutation({
    mutationFn: async (changeId: string) => {
      await apiDelete(
        `/api/medications/${medicationId}/glp1/dose-change/${changeId}`,
      );
      return changeId;
    },
    onSuccess: () => {
      invalidate();
      toast.success(t("medications.titration.builder.removed"));
    },
    onError: () => {
      toast.error(t("medications.titration.builder.saveError"));
    },
  });

  const enteredCount = doses.filter((d) => parseDoseValue(d) !== null).length;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-slot="titration-plan-builder-cta"
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {t("medications.titration.builder.cta")}
      </Button>

      <ResponsiveSheet
        open={open}
        onOpenChange={setOpen}
        title={t("medications.titration.builder.title")}
        description={t("medications.titration.builder.subtitle")}
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={save.isPending}
            >
              {t("medications.titration.builder.close")}
            </Button>
            <Button
              type="button"
              disabled={save.isPending || enteredCount === 0}
              onClick={() => save.mutate()}
            >
              {save.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {t("medications.titration.builder.save")}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <p
            className="text-muted-foreground text-xs"
            data-slot="titration-plan-safety"
          >
            {t("medications.titration.builder.safetyNote")}
          </p>

          {existing.length > 0 && (
            <div className="space-y-2" data-slot="titration-plan-existing">
              <h3 className="text-foreground text-sm font-medium">
                {t("medications.titration.builder.currentPlan")}
              </h3>
              <ul className="space-y-1">
                {existing.map((dc) => (
                  <li
                    key={dc.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
                  >
                    <span className="text-foreground text-sm tabular-nums">
                      {t("medications.titration.doseStep", {
                        dose: fmt.number(dc.doseValue),
                        unit: dc.doseUnit,
                      })}
                    </span>
                    <span className="text-muted-foreground flex items-center gap-2 text-xs">
                      {fmt.dateShortSmart(new Date(dc.effectiveFrom))}
                      <button
                        type="button"
                        aria-label={t(
                          "medications.titration.builder.removeStep",
                        )}
                        className="text-muted-foreground hover:text-destructive rounded p-1"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(dc.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-3" data-slot="titration-plan-new">
            <h3 className="text-foreground text-sm font-medium">
              {t("medications.titration.builder.newSteps")}
            </h3>

            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  {t("medications.titration.builder.startDate")}
                </span>
                <DateField
                  value={startDate}
                  onChange={setStartDate}
                  aria-label={t("medications.titration.builder.startDate")}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  {t("medications.titration.builder.interval")}
                </span>
                <NativeSelect
                  className="w-auto"
                  value={intervalDays}
                  onChange={(e) => setIntervalDays(Number(e.target.value))}
                  aria-label={t("medications.titration.builder.interval")}
                >
                  {INTERVAL_OPTIONS.map((days) => (
                    <option key={days} value={days}>
                      {t("medications.titration.builder.everyNDays", {
                        count: days,
                      })}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  {t("medications.titration.builder.unit")}
                </span>
                <Input
                  className="w-24"
                  value={unit}
                  maxLength={10}
                  onChange={(e) => setUnit(e.target.value)}
                  aria-label={t("medications.titration.builder.unit")}
                />
              </label>
            </div>

            <ul className="space-y-2" data-slot="titration-plan-step-rows">
              {doses.map((dose, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="text-muted-foreground w-28 shrink-0 text-xs tabular-nums">
                    {fmt.dateShortSmart(
                      new Date(
                        `${stepDateIso(startDate, i, intervalDays)}T12:00:00Z`,
                      ),
                    )}
                  </span>
                  <Input
                    type="text"
                    inputMode="decimal"
                    className="w-28"
                    placeholder={t(
                      "medications.titration.builder.dosePlaceholder",
                    )}
                    value={dose}
                    aria-label={t("medications.titration.builder.doseAria", {
                      step: i + 1,
                    })}
                    onChange={(e) =>
                      setDoses((prev) =>
                        prev.map((d, j) => (j === i ? e.target.value : d)),
                      )
                    }
                  />
                  <span className="text-muted-foreground text-xs">{unit}</span>
                  {doses.length > 1 && (
                    <button
                      type="button"
                      aria-label={t("medications.titration.builder.removeStep")}
                      className="text-muted-foreground hover:text-destructive rounded p-1"
                      onClick={() =>
                        setDoses((prev) => prev.filter((_, j) => j !== i))
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDoses((prev) => [...prev, ""])}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("medications.titration.builder.addStep")}
            </Button>
          </div>
        </div>
      </ResponsiveSheet>
    </>
  );
}
