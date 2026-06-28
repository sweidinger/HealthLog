"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GlassWater, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { ApiError, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import {
  queryKeys,
  invalidateKeys,
  measurementDependentKeys,
} from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/insights/section-heading";
import { HydrationRing } from "@/components/insights/hydration-ring";
import {
  HYDRATION_QUICK_ADD_ML,
  MAX_HYDRATION_ENTRY_ML,
  MAX_HYDRATION_GOAL_ML,
  MIN_HYDRATION_ENTRY_ML,
  MIN_HYDRATION_GOAL_ML,
} from "@/lib/hydration/hydration";

/**
 * v1.25 — hydration daily-goal card.
 *
 * A calm goal tracker for the Insights overview: a goal ring (today's summed
 * WATER_INTAKE vs the user's goal), quick-add buttons (+250 / +500 ml and a
 * custom amount), and an inline goal editor. Logging rides the existing
 * measurements create path (POST /api/measurements, type WATER_INTAKE), so a
 * new entry busts `measurementDependentKeys`, which carries the hydration key —
 * the ring refreshes in lockstep. The goal write goes to PATCH /api/hydration.
 *
 * Always present (a goal ring at 0 / goal is still useful), unlike the
 * insufficient-history read cards which un-mount.
 */

interface HydrationTodayResponse {
  date: string;
  totalMl: number;
  goalMl: number;
  percent: number;
  rawPercent: number;
  met: boolean;
  remainingMl: number;
  entries: { id: string; value: number; measuredAt: string }[];
}

interface HydrationCardProps {
  enabled?: boolean;
  className?: string;
}

export function HydrationCard({
  enabled = true,
  className,
}: HydrationCardProps) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState(false);
  const [customMl, setCustomMl] = useState("");
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");

  const gated = enabled && isAuthenticated;

  const { data } = useQuery({
    queryKey: queryKeys.hydrationToday(),
    queryFn: () => apiGet<HydrationTodayResponse>("/api/hydration"),
    enabled: gated,
    staleTime: 60_000,
  });

  async function logAmount(ml: number) {
    if (busy || ml <= 0) return;
    setBusy(true);
    try {
      await apiPost("/api/measurements", {
        type: "WATER_INTAKE",
        value: ml,
        measuredAt: new Date().toISOString(),
      });
      await invalidateKeys(queryClient, measurementDependentKeys);
      toast.success(t("hydration.added", { amount: ml }));
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.message
          ? err.message
          : t("hydration.saveError"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function logCustom() {
    const ml = Math.round(Number(customMl));
    if (
      !Number.isFinite(ml) ||
      ml < MIN_HYDRATION_ENTRY_ML ||
      ml > MAX_HYDRATION_ENTRY_ML
    ) {
      toast.error(t("hydration.invalidAmount"));
      return;
    }
    await logAmount(ml);
    setCustomMl("");
  }

  async function saveGoal() {
    const ml = Math.round(Number(goalDraft));
    if (
      !Number.isFinite(ml) ||
      ml < MIN_HYDRATION_GOAL_ML ||
      ml > MAX_HYDRATION_GOAL_ML
    ) {
      toast.error(t("hydration.invalidGoal"));
      return;
    }
    setBusy(true);
    try {
      await apiPatch("/api/hydration", { goalMl: ml });
      await invalidateKeys(queryClient, [queryKeys.hydration()]);
      setEditingGoal(false);
      toast.success(t("hydration.goalSaved"));
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.message
          ? err.message
          : t("hydration.saveError"),
      );
    } finally {
      setBusy(false);
    }
  }

  const totalMl = data?.totalMl ?? 0;
  const goalMl = data?.goalMl ?? 0;
  const percent = data?.percent ?? 0;
  const met = data?.met ?? false;
  const remainingMl = data?.remainingMl ?? 0;

  return (
    <section
      data-slot="hydration-section"
      aria-label={t("hydration.cardTitle")}
      className={cn("space-y-3", className)}
    >
      <SectionHeading
        icon={GlassWater}
        title={t("hydration.cardTitle")}
        action={
          editingGoal ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2"
              onClick={() => {
                setGoalDraft(String(goalMl || ""));
                setEditingGoal(true);
              }}
              data-slot="hydration-edit-goal"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="text-xs">{t("hydration.editGoal")}</span>
            </Button>
          )
        }
      />

      <div
        data-slot="hydration-card"
        className="bg-card flex w-full min-w-0 flex-col items-center gap-4 rounded-xl border p-4 md:flex-row md:items-center md:gap-6 md:p-6"
      >
        <HydrationRing
          percent={percent}
          totalMl={totalMl}
          goalMl={goalMl}
          met={met}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p
            className="text-muted-foreground text-sm"
            data-slot="hydration-status"
            role="status"
          >
            {met
              ? t("hydration.metMessage")
              : t("hydration.remainingMessage", { amount: remainingMl })}
          </p>

          {editingGoal ? (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={MIN_HYDRATION_GOAL_ML}
                max={MAX_HYDRATION_GOAL_ML}
                value={goalDraft}
                onChange={(e) => setGoalDraft(e.target.value)}
                aria-label={t("hydration.goalLabel")}
                className="h-9 w-28"
                data-slot="hydration-goal-input"
              />
              <span className="text-muted-foreground text-xs">ml</span>
              <Button
                type="button"
                size="sm"
                className="h-9"
                disabled={busy}
                onClick={saveGoal}
              >
                {t("common.save")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-9"
                onClick={() => setEditingGoal(false)}
              >
                {t("common.cancel")}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {HYDRATION_QUICK_ADD_ML.map((ml) => (
                  <Button
                    key={ml}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1"
                    disabled={busy}
                    onClick={() => logAmount(ml)}
                    data-slot="hydration-quick-add"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    {`${ml} ml`}
                  </Button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={MIN_HYDRATION_ENTRY_ML}
                  max={MAX_HYDRATION_ENTRY_ML}
                  placeholder={t("hydration.customPlaceholder")}
                  value={customMl}
                  onChange={(e) => setCustomMl(e.target.value)}
                  aria-label={t("hydration.customLabel")}
                  className="h-9 w-28"
                  data-slot="hydration-custom-input"
                />
                <span className="text-muted-foreground text-xs">ml</span>
                <Button
                  type="button"
                  size="sm"
                  className="h-9 gap-1"
                  disabled={busy || customMl.trim() === ""}
                  onClick={logCustom}
                >
                  {met ? (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {t("hydration.add")}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
