"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslations } from "@/lib/i18n/context";
import {
  DEFAULT_COACH_PREFS,
  type CoachExcludeMetric,
  type CoachPrefs,
  type CoachTone,
  type CoachVerbosity,
} from "@/lib/validations/coach-prefs";

/**
 * v1.4.23 H4 — per-user Coach prompt-tuning sheet.
 *
 * Surfaced from the Coach drawer header cog. Reads + writes
 * `/api/auth/me/coach-prefs`. Mounted as a right-edge `<Sheet>` so it
 * sits on top of the drawer without conflicting with the existing
 * mobile rail trays (history = left, sources = right tray on `<xl`,
 * settings = right sheet — fine because the user only opens one at a
 * time).
 *
 * The four controls match the v1.4.23 H4 spec exactly: tone (3-state),
 * verbosity (3-state), excludeMetrics (multi-toggle), and
 * showEvidenceByDefault (single toggle).
 */
export interface CoachSettingsSheetProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

const EXCLUDE_OPTIONS: CoachExcludeMetric[] = [
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
  "hrv",
  "sleep",
  "resting_hr",
  "steps",
];

export function CoachSettingsSheet({
  open,
  onOpenChange,
}: CoachSettingsSheetProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data: persisted } = useQuery({
    queryKey: ["coach-prefs"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me/coach-prefs");
      if (!res.ok) throw new Error("coach-prefs.fetch_failed");
      const env = (await res.json()) as { data: CoachPrefs };
      return env.data;
    },
    enabled: open,
  });

  // Local working copy edited by the form. Re-syncs to the persisted
  // shape on every fetch via the same in-render setState pattern as
  // the drawer's `useResettableValue` (no useEffect — the
  // `react-hooks/set-state-in-effect` rule rejects setState inside an
  // effect when the source is a query result).
  const [draft, setDraft] = useState<CoachPrefs>(DEFAULT_COACH_PREFS);
  const [lastSeenPersisted, setLastSeenPersisted] = useState<CoachPrefs | null>(
    null,
  );
  if (persisted && persisted !== lastSeenPersisted) {
    setLastSeenPersisted(persisted);
    setDraft(persisted);
  }

  const save = useMutation({
    mutationFn: async (next: CoachPrefs) => {
      const res = await fetch("/api/auth/me/coach-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error("coach-prefs.save_failed");
      return (await res.json()) as { data: CoachPrefs };
    },
    onSuccess: (envelope) => {
      queryClient.setQueryData(["coach-prefs"], envelope.data);
      onOpenChange(false);
    },
  });

  function toggleExclude(metric: CoachExcludeMetric, next: boolean) {
    setDraft((prev) => ({
      ...prev,
      excludeMetrics: next
        ? Array.from(new Set([...prev.excludeMetrics, metric]))
        : prev.excludeMetrics.filter((m) => m !== metric),
    }));
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        data-slot="coach-settings-sheet"
        className="w-full p-0 sm:max-w-[420px] flex h-[100dvh] flex-col gap-0"
      >
        <SheetHeader className="border-border/70 border-b p-4 pr-12">
          <SheetTitle className="text-sm font-semibold">
            {t("insights.coach.settingsTitle")}
          </SheetTitle>
          <SheetDescription className="text-muted-foreground text-xs">
            {t("insights.coach.settingsDescription")}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
          {/* Tone */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="coach-prefs-tone"
              className="text-xs font-medium"
            >
              {t("insights.coach.settingsToneLabel")}
            </Label>
            <Select
              value={draft.tone}
              onValueChange={(value) =>
                setDraft((prev) => ({ ...prev, tone: value as CoachTone }))
              }
            >
              <SelectTrigger
                id="coach-prefs-tone"
                data-slot="coach-prefs-tone"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="warm">
                  {t("insights.coach.settingsToneWarm")}
                </SelectItem>
                <SelectItem value="neutral">
                  {t("insights.coach.settingsToneNeutral")}
                </SelectItem>
                <SelectItem value="concise">
                  {t("insights.coach.settingsToneConcise")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Verbosity */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="coach-prefs-verbosity"
              className="text-xs font-medium"
            >
              {t("insights.coach.settingsVerbosityLabel")}
            </Label>
            <Select
              value={draft.verbosity}
              onValueChange={(value) =>
                setDraft((prev) => ({
                  ...prev,
                  verbosity: value as CoachVerbosity,
                }))
              }
            >
              <SelectTrigger
                id="coach-prefs-verbosity"
                data-slot="coach-prefs-verbosity"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="brief">
                  {t("insights.coach.settingsVerbosityBrief")}
                </SelectItem>
                <SelectItem value="default">
                  {t("insights.coach.settingsVerbosityDefault")}
                </SelectItem>
                <SelectItem value="detailed">
                  {t("insights.coach.settingsVerbosityDetailed")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Exclude metrics */}
          <div className="flex flex-col gap-2">
            <Label className="text-xs font-medium">
              {t("insights.coach.settingsExcludeLabel")}
            </Label>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              {t("insights.coach.settingsExcludeHint")}
            </p>
            <ul
              data-slot="coach-prefs-exclude-list"
              className="border-border/60 divide-border/50 mt-1 flex flex-col divide-y rounded-md border"
            >
              {EXCLUDE_OPTIONS.map((metric) => {
                const id = `coach-prefs-exclude-${metric}`;
                const checked = draft.excludeMetrics.includes(metric);
                return (
                  <li
                    key={metric}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <Label htmlFor={id} className="cursor-pointer text-xs">
                      {t(`insights.coach.metric.${metric}`)}
                    </Label>
                    <Switch
                      id={id}
                      data-slot={`coach-prefs-exclude-${metric}`}
                      checked={checked}
                      onCheckedChange={(next) => toggleExclude(metric, next)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Show evidence by default */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="coach-prefs-evidence"
                className="cursor-pointer text-xs font-medium"
              >
                {t("insights.coach.settingsEvidenceLabel")}
              </Label>
              <p className="text-muted-foreground text-[11px] leading-relaxed">
                {t("insights.coach.settingsEvidenceHint")}
              </p>
            </div>
            <Switch
              id="coach-prefs-evidence"
              data-slot="coach-prefs-evidence"
              checked={draft.showEvidenceByDefault}
              onCheckedChange={(next) =>
                setDraft((prev) => ({
                  ...prev,
                  showEvidenceByDefault: next,
                }))
              }
            />
          </div>
        </div>

        <div className="border-border/70 flex items-center justify-end gap-2 border-t p-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-slot="coach-prefs-cancel"
          >
            {t("insights.coach.settingsCancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => save.mutate(draft)}
            disabled={save.isPending}
            data-slot="coach-prefs-save"
          >
            {save.isPending ? (
              <Loader2
                className="size-3.5 animate-spin"
                aria-hidden="true"
              />
            ) : null}
            {t("insights.coach.settingsSave")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
