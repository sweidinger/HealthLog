"use client";

/**
 * v1.16.1 — Settings → AI "Coach preferences" card.
 *
 * The prompt-tuning form moved out of the in-chat sheet
 * (`coach-settings-sheet.tsx`, retired) into the AI settings section so
 * model + behaviour live in one place; the chat header keeps a gear
 * that deep-links here. Reads + writes `/api/auth/me/coach-prefs`
 * through the shared `useCoachPrefs` / `useSaveCoachPrefs` pair — the
 * same persisted row the chat's "What I draw on" rail edits.
 *
 * One source of truth for data scope: `excludeMetrics`. The optional
 * context group (sleep / medications / profile) used to render its own
 * switches with the same checked-polarity as the exclude list, so
 * "exclude sleep" and "send sleep context" could read as both ON at
 * once. The context switches now DERIVE from the exclusion list
 * (checked = not excluded = sent), so the two groups can never
 * contradict each other.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachPrefs, useSaveCoachPrefs } from "@/hooks/use-coach-prefs";
import {
  DEFAULT_COACH_CLUSTERS,
  DEFAULT_COACH_PREFS,
  coachDataClusterEnum,
  type CoachDataCluster,
  type CoachDefaultWindow,
  type CoachExcludeMetric,
  type CoachPrefs,
  type CoachTone,
  type CoachVerbosity,
} from "@/lib/validations/coach-prefs";

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

// Optional context blocks. Derived from `excludeMetrics` (see header
// comment): a switch here reads "send this block" and is simply the
// inverse of the exclusion entry.
const CONTEXT_OPTIONS: CoachExcludeMetric[] = [
  "sleep",
  "medications",
  "anthropometrics",
];

const DEFAULT_WINDOW_OPTIONS: CoachDefaultWindow[] = [
  "last7days",
  "last30days",
  "last90days",
  "allTime",
];

const CLUSTER_OPTIONS: CoachDataCluster[] = coachDataClusterEnum.options;

export interface CoachPrefsSectionProps {
  isAuthenticated: boolean;
}

export function CoachPrefsSection({ isAuthenticated }: CoachPrefsSectionProps) {
  const { t } = useTranslations();

  const { data: persisted } = useCoachPrefs({ enabled: isAuthenticated });

  // Local working copy edited by the form; re-syncs to the persisted
  // shape on every fetch via the in-render setState pattern (the
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

  const save = useSaveCoachPrefs({
    onSuccess: () => {
      toast.success(t("insights.coach.settingsSaved"));
    },
  });

  function setExcluded(metric: CoachExcludeMetric, excluded: boolean) {
    setDraft((prev) => ({
      ...prev,
      excludeMetrics: excluded
        ? Array.from(new Set([...prev.excludeMetrics, metric]))
        : prev.excludeMetrics.filter((m) => m !== metric),
    }));
  }

  function toggleCluster(cluster: CoachDataCluster, next: boolean) {
    setDraft((prev) => {
      const current = prev.dataClusters ?? Array.from(DEFAULT_COACH_CLUSTERS);
      const updated = next
        ? Array.from(new Set([...current, cluster]))
        : current.filter((c) => c !== cluster);
      return { ...prev, dataClusters: updated };
    });
  }

  const enabledClusters = new Set<CoachDataCluster>(
    draft.dataClusters ?? DEFAULT_COACH_CLUSTERS,
  );

  const isLoading = isAuthenticated && !persisted;

  return (
    <Card data-slot="coach-prefs-section">
      <CardHeader>
        <CardTitle className="text-lg font-semibold">
          {t("insights.coach.settingsTitle")}
        </CardTitle>
        <CardDescription>
          {t("insights.coach.settingsDescription")}
        </CardDescription>
      </CardHeader>
      {isLoading ? (
        <CardContent
          data-slot="coach-prefs-skeleton"
          className="flex flex-col gap-5"
        >
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-44 w-full" />
          </div>
        </CardContent>
      ) : (
        <CardContent className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {/* Tone */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="coach-prefs-tone" className="text-xs font-medium">
                {t("insights.coach.settingsToneLabel")}
              </Label>
              <Select
                value={draft.tone}
                onValueChange={(value) =>
                  setDraft((prev) => ({ ...prev, tone: value as CoachTone }))
                }
              >
                <SelectTrigger id="coach-prefs-tone" data-slot="coach-prefs-tone">
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
          </div>

          {/* Default analysis window */}
          <div className="flex flex-col gap-2">
            <Label
              htmlFor="coach-prefs-default-window"
              className="text-xs font-medium"
            >
              {t("insights.coach.settingsDefaultWindowLabel")}
            </Label>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              {t("insights.coach.settingsDefaultWindowHint")}
            </p>
            <Select
              value={draft.defaultWindow}
              onValueChange={(value) =>
                setDraft((prev) => ({
                  ...prev,
                  defaultWindow: value as CoachDefaultWindow,
                }))
              }
            >
              <SelectTrigger
                id="coach-prefs-default-window"
                data-slot="coach-prefs-default-window"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEFAULT_WINDOW_OPTIONS.map((w) => (
                  <SelectItem key={w} value={w}>
                    {t(`insights.coach.window.${w}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Clustered, opt-in data sources */}
          <div className="flex flex-col gap-2">
            <Label className="text-xs font-medium">
              {t("insights.coach.settingsClustersLabel")}
            </Label>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              {t("insights.coach.settingsClustersHint")}
            </p>
            <ul
              data-slot="coach-prefs-cluster-list"
              className="border-border/60 divide-border/50 mt-1 flex flex-col divide-y rounded-md border"
            >
              {CLUSTER_OPTIONS.map((cluster) => {
                const id = `coach-prefs-cluster-${cluster}`;
                const checked = enabledClusters.has(cluster);
                return (
                  <li
                    key={cluster}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-col">
                      <Label
                        htmlFor={id}
                        className="cursor-pointer text-xs font-medium"
                      >
                        {t(`insights.coach.cluster.${cluster}.label`)}
                      </Label>
                      <span className="text-muted-foreground text-[11px] leading-snug">
                        {t(`insights.coach.cluster.${cluster}.hint`)}
                      </span>
                    </div>
                    <Switch
                      id={id}
                      data-slot={`coach-prefs-cluster-${cluster}`}
                      checked={checked}
                      onCheckedChange={(next) => toggleCluster(cluster, next)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Exclude metrics — checked = excluded. */}
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
                      onCheckedChange={(next) => setExcluded(metric, next)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Optional context blocks — checked = sent, derived as the
              inverse of the exclusion list so the two groups can never
              contradict each other. */}
          <div className="flex flex-col gap-2">
            <Label className="text-xs font-medium">
              {t("insights.coach.settingsContextLabel")}
            </Label>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              {t("insights.coach.settingsContextHint")}
            </p>
            <ul
              data-slot="coach-prefs-context-list"
              className="border-border/60 divide-border/50 mt-1 flex flex-col divide-y rounded-md border"
            >
              {CONTEXT_OPTIONS.map((metric) => {
                const id = `coach-prefs-context-${metric}`;
                const sent = !draft.excludeMetrics.includes(metric);
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
                      data-slot={`coach-prefs-context-${metric}`}
                      checked={sent}
                      onCheckedChange={(next) => setExcluded(metric, !next)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        </CardContent>
      )}
      <CardFooter className="justify-end">
        <Button
          type="button"
          size="sm"
          onClick={() => save.mutate(draft)}
          disabled={save.isPending || isLoading}
          data-slot="coach-prefs-save"
        >
          {save.isPending ? (
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          {t("insights.coach.settingsSave")}
        </Button>
      </CardFooter>
    </Card>
  );
}
