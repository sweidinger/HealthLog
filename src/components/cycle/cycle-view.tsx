"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Plus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { CycleRing } from "./cycle-ring";
import { BbtChart } from "./bbt-chart";
import { CycleCalendar } from "./cycle-calendar";
import { CycleDisclaimer } from "./cycle-disclaimer";
import { CycleHistoryChart } from "./cycle-history-chart";
import { LogDaySheet } from "./log-day-sheet";
import { PhaseEducationCard } from "./phase-education-card";
import { PredictionsPanel } from "./predictions-panel";
import { CyclePhaseHeadline, CyclePhaseCrosstab } from "./cycle-phase-crosstab";
import { CycleSymptomPatterns } from "./cycle-symptom-patterns";
import { CycleSettings } from "./cycle-settings";
import { deriveWheelState } from "./wheel-state";
import { PHASE_HUE } from "./phase-tokens";
import {
  localYmd,
  useCycleCalendar,
  useCycleHistory,
  useCycleInsights,
  useCycleProfile,
} from "./use-cycle";

/**
 * v1.15.0 — the cycle vertical's client orchestrator.
 *
 * Holds the four tabs (Calendar · Predictions · Insights · Settings), the
 * wheel above the tab strip, and the log-day sheet. The calendar read drives
 * the ring (day-of-cycle + phase), the grid, and the BBT chart; the
 * predictions read powers the panel; history powers the stats. The page-level
 * RSC has already gated on `cycleTrackingEnabled`.
 *
 * The wheel earns the once-per-session "signature reveal" (sweep + glow +
 * sheen + count-up): a `data-revealed` flag set on first visit drives the CSS
 * keyframes, gated by sessionStorage so a background calendar refetch never
 * re-triggers the moment.
 */

/** YYYY-MM-DD for `n` days from now in the local tz (shares `localYmd`). */
function shiftToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localYmd(d);
}

/** The four cycle tabs, in render order. The deep-link value is validated
 *  against this set so a junk `?tab=` falls back to the calendar tab. */
const CYCLE_TABS = ["calendar", "predictions", "insights", "settings"] as const;
type CycleTab = (typeof CYCLE_TABS)[number];

export function CycleView() {
  const { t } = useTranslations();

  // Deep-link support: `/cycle?tab=insights` opens the insights tab. The value
  // is read ONCE for the initial `defaultValue` (uncontrolled tabs — so normal
  // clicking still works), validated against the known set, and falls back to
  // the calendar tab on anything else.
  const searchParams = useSearchParams();
  const initialTab: CycleTab = useMemo(() => {
    const raw = searchParams?.get("tab");
    return raw && (CYCLE_TABS as readonly string[]).includes(raw)
      ? (raw as CycleTab)
      : "calendar";
  }, [searchParams]);

  const today = useMemo(() => shiftToday(0), []);
  const from = useMemo(() => shiftToday(-90), []);
  const to = useMemo(() => shiftToday(180), []);

  const calendar = useCycleCalendar(from, to);
  const history = useCycleHistory();
  const profileQuery = useCycleProfile();
  const insights = useCycleInsights();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState(today);

  // The signature reveal plays ONCE per browser session (mirrors the wellness
  // strip): a background calendar refetch after a quick-log would otherwise
  // replay the sweep/sheen and read as janky.
  const [play] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      if (sessionStorage.getItem("cycle-wheel-revealed")) return false;
      sessionStorage.setItem("cycle-wheel-revealed", "1");
      return true;
    } catch {
      return true;
    }
  });

  const wheel = useMemo(
    () => deriveWheelState(calendar.data?.days ?? [], today),
    [calendar.data, today],
  );

  function openSheet(date: string) {
    setSelectedDate(date);
    setSheetOpen(true);
  }

  const loading = calendar.isLoading && !calendar.data;
  const calendarError = calendar.isError && !calendar.data;
  const tileHue = wheel.phase ? PHASE_HUE[wheel.phase] : undefined;
  // AVOID_PREGNANCY surfaces the fertile window, so it must show the stronger
  // "not a contraceptive method" caveat. Prefer the server-resolved
  // prediction.disclaimer (already goal-correct); fall back to the goal-derived
  // key for the no-prediction calendar tab (QA H-1).
  const goal = calendar.data?.profile.goal;
  // Honesty-gate inputs for the phase-education card (Clue precedent): the
  // predictive phase framing only shows when prediction is on, not in
  // raw-chart mode, and at least three cycles are observed.
  const calProfile = calendar.data?.profile;
  const disclaimerText =
    calendar.data?.prediction?.disclaimer ??
    t(
      goal === "AVOID_PREGNANCY"
        ? "cycle.disclaimer"
        : "cycle.prediction.disclaimer",
    );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("cycle.title")}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t("cycle.subtitle")}
          </p>
        </div>
        <Button onClick={() => openSheet(today)} className="gap-2">
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">{t("cycle.logToday")}</span>
        </Button>
      </div>

      {/* Desktop: ring (left) + tabs (right). Single column below lg. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
        {/* Wheel + compact phase card — grouped so they stick together. */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-6">
        {/* Wheel — the signature ring on the premium wellness-tile surface. */}
        <div
          data-slot="cycle-wheel-tile"
          data-revealed={play ? "true" : undefined}
          style={
            tileHue
              ? ({ "--tile-hue": tileHue } as React.CSSProperties)
              : undefined
          }
          className={cn(
            "wellness-tile flex flex-col items-center gap-3 rounded-xl px-6 py-6",
            play && "wellness-tile-rise",
          )}
        >
          {loading ? (
            <div className="flex h-[220px] items-center justify-center">
              <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
            </div>
          ) : calendarError ? (
            <div className="flex h-[220px] flex-col items-center justify-center gap-3 text-center">
              <p className="text-muted-foreground text-sm">
                {t("cycle.loadError")}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => void calendar.refetch()}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                {t("common.retry")}
              </Button>
            </div>
          ) : (
            <CycleRing
              dayOfCycle={wheel.dayOfCycle}
              cycleLength={wheel.cycleLength}
              phase={wheel.phase}
              spans={wheel.spans}
              animate={play}
            />
          )}
          {!calendarError ? (
            <p className="text-muted-foreground text-xs">
              {t("cycle.ring.caption")}
            </p>
          ) : null}
          {/* First-period CTA — only when no cycle is active yet. */}
          {!loading && !calendarError && wheel.dayOfCycle == null ? (
            <Button
              variant="outline"
              className="mt-1 w-full"
              onClick={() => openSheet(today)}
            >
              {t("cycle.ring.firstPeriodCta")}
            </Button>
          ) : null}
        </div>

          {/* Phase-education card beneath the wheel — the single instance,
              including the "you often notice this here" chip row sourced from
              the user's own symptom-by-phase history. */}
          {!loading && !calendarError ? (
            <PhaseEducationCard
              animate={play}
              phase={wheel.phase}
              symptomPatterns={insights.data?.symptomPatterns ?? []}
              predictionEnabled={calProfile?.predictionEnabled ?? false}
              rawChartMode={calProfile?.rawChartMode ?? false}
              cyclesObserved={calProfile?.cyclesObserved ?? 0}
              onLogToday={() => openSheet(today)}
            />
          ) : null}
        </div>

        <Tabs defaultValue={initialTab}>
          <TabsList className="w-full">
            <TabsTrigger value="calendar" className="flex-1">
              {t("cycle.tabs.calendar")}
            </TabsTrigger>
            <TabsTrigger value="predictions" className="flex-1">
              {t("cycle.tabs.predictions")}
            </TabsTrigger>
            <TabsTrigger value="insights" className="flex-1">
              {t("cycle.tabs.insights")}
            </TabsTrigger>
            <TabsTrigger value="settings" className="flex-1">
              {t("cycle.tabs.settings")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="calendar" className="mt-4 space-y-4">
            <Card>
              <CardContent className="py-4">
                {loading ? (
                  <p className="text-muted-foreground text-sm">
                    {t("cycle.calendar.loading")}
                  </p>
                ) : calendarError ? (
                  <TabError onRetry={() => void calendar.refetch()} />
                ) : (
                  <CycleCalendar
                    days={calendar.data?.days ?? []}
                    today={today}
                    confirmedOvulation={
                      calendar.data?.prediction?.ovulationConfirmed
                        ? (calendar.data.prediction.predictedOvulation ?? null)
                        : null
                    }
                    onSelectDay={openSheet}
                  />
                )}
              </CardContent>
            </Card>
            {!loading && !calendarError ? (
              <CycleDisclaimer text={disclaimerText} />
            ) : null}
          </TabsContent>

          <TabsContent value="predictions" className="mt-4 space-y-4">
            {calendarError ? (
              <Card>
                <CardContent className="py-4">
                  <TabError onRetry={() => void calendar.refetch()} />
                </CardContent>
              </Card>
            ) : (
              <>
                <PredictionsPanel
                  prediction={calendar.data?.prediction ?? null}
                  rawChartMode={calendar.data?.profile.rawChartMode ?? false}
                  history={history.data}
                  fallbackDisclaimer={disclaimerText}
                  goal={goal}
                />
                <CycleHistoryChart history={history.data} animate={play} />
                <BbtChart
                  days={calendar.data?.days ?? []}
                  today={today}
                  predictedOvulation={
                    calendar.data?.prediction?.predictedOvulation ?? null
                  }
                  ovulationConfirmed={
                    calendar.data?.prediction?.ovulationConfirmed ?? false
                  }
                  rawChartMode={calendar.data?.profile.rawChartMode ?? false}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="insights" className="mt-4 space-y-4">
            {insights.isError ? (
              <Card>
                <CardContent className="py-4">
                  <TabError onRetry={() => void insights.refetch()} />
                </CardContent>
              </Card>
            ) : (
              <>
                <CyclePhaseHeadline
                  headline={insights.data?.headline ?? null}
                />
                <CyclePhaseCrosstab rows={insights.data?.rows ?? []} />
                <CycleSymptomPatterns
                  rows={insights.data?.symptomPatterns ?? []}
                />
              </>
            )}
          </TabsContent>

          <TabsContent value="settings" className="mt-4">
            {profileQuery.isError ? (
              <Card>
                <CardContent className="py-4">
                  <TabError onRetry={() => void profileQuery.refetch()} />
                </CardContent>
              </Card>
            ) : profileQuery.isLoading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
              </div>
            ) : profileQuery.data ? (
              <CycleSettings
                key={profileQuery.data.updatedAt}
                profile={profileQuery.data}
              />
            ) : null}
          </TabsContent>
        </Tabs>
      </div>

      <LogDaySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        date={selectedDate}
        today={today}
        activePeriod={wheel.phase === "MENSTRUAL"}
      />
    </div>
  );
}

/** A compact in-place error + Retry for a failed tab read. */
function TabError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslations();
  return (
    <div
      role="alert"
      data-slot="cycle-tab-error"
      className="text-muted-foreground flex flex-col items-start gap-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <span>{t("cycle.loadError")}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onRetry}
        className="gap-1.5"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{t("common.retry")}</span>
      </Button>
    </div>
  );
}
