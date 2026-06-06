"use client";

import { useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTranslations } from "@/lib/i18n/context";
import { CycleRing } from "./cycle-ring";
import { CycleCalendar } from "./cycle-calendar";
import { LogDaySheet } from "./log-day-sheet";
import { PredictionsPanel } from "./predictions-panel";
import {
  CyclePhaseHeadline,
  CyclePhaseCrosstab,
} from "./cycle-phase-crosstab";
import { CycleSettings } from "./cycle-settings";
import { deriveWheelState } from "./wheel-state";
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
 * wheel + month calendar above the tab strip, and the log-day sheet. The
 * calendar read drives the ring (day-of-cycle + phase) and the grid; the
 * predictions read powers the panel; history powers the stats. The page-level
 * RSC has already gated on `cycleTrackingEnabled`.
 */

/** YYYY-MM-DD for `n` days from now in the local tz (shares `localYmd`). */
function shiftToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localYmd(d);
}

export function CycleView() {
  const { t } = useTranslations();

  const today = useMemo(() => shiftToday(0), []);
  const from = useMemo(() => shiftToday(-90), []);
  const to = useMemo(() => shiftToday(180), []);

  const calendar = useCycleCalendar(from, to);
  const history = useCycleHistory();
  const profileQuery = useCycleProfile();
  const insights = useCycleInsights();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState(today);

  const wheel = useMemo(
    () => deriveWheelState(calendar.data?.days ?? [], today),
    [calendar.data, today],
  );

  function openSheet(date: string) {
    setSelectedDate(date);
    setSheetOpen(true);
  }

  const loading = calendar.isLoading && !calendar.data;

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
      {/* Wheel — the signature ring. */}
      <Card className="lg:sticky lg:top-6">
        <CardContent className="flex flex-col items-center gap-3 py-6">
          {loading ? (
            <div className="flex h-[220px] items-center justify-center">
              <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
            </div>
          ) : (
            <CycleRing
              dayOfCycle={wheel.dayOfCycle}
              cycleLength={wheel.cycleLength}
              phase={wheel.phase}
              spans={wheel.spans}
            />
          )}
          <p className="text-muted-foreground text-xs">
            {t("cycle.ring.caption")}
          </p>
          {/* First-period CTA — only when no cycle is active yet. */}
          {!loading && wheel.dayOfCycle == null ? (
            <Button
              variant="outline"
              className="mt-1 w-full"
              onClick={() => openSheet(today)}
            >
              {t("cycle.ring.firstPeriodCta")}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Tabs defaultValue="calendar">
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

        <TabsContent value="calendar" className="mt-4">
          <Card>
            <CardContent className="py-4">
              {loading ? (
                <p className="text-muted-foreground text-sm">
                  {t("cycle.calendar.loading")}
                </p>
              ) : (
                <CycleCalendar
                  days={calendar.data?.days ?? []}
                  today={today}
                  onSelectDay={openSheet}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="predictions" className="mt-4">
          <PredictionsPanel
            prediction={calendar.data?.prediction ?? null}
            rawChartMode={calendar.data?.profile.rawChartMode ?? false}
            history={history.data}
          />
        </TabsContent>

        <TabsContent value="insights" className="mt-4 space-y-4">
          <CyclePhaseHeadline headline={insights.data?.headline ?? null} />
          <CyclePhaseCrosstab rows={insights.data?.rows ?? []} />
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          {profileQuery.data ? (
            <CycleSettings
              key={profileQuery.data.updatedAt}
              profile={profileQuery.data}
            />
          ) : (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
            </div>
          )}
        </TabsContent>
      </Tabs>
      </div>

      <LogDaySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        date={selectedDate}
        today={today}
      />
    </div>
  );
}
