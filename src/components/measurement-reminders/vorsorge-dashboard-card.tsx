"use client";

/**
 * v1.18.2 — Vorsorge (preventive-care) dashboard summary card.
 *
 * A compact chart-row card listing the next few due reminders with an
 * inline primary action per row — the same done-vs-capture branch the
 * dedicated `/vorsorge` page surfaces, scaled down for the dashboard.
 * A free-text / self-planned exam marks done silently; a measurement-
 * linked reminder opens the real measurement-entry form and satisfies
 * the reminder in the same action.
 *
 * Mirrors the medication compliance card's role on the chart row:
 * chart-row only, no strip tile. Self-skeletons while the read is in
 * flight and self-gates to a brief empty state otherwise.
 */
import { useState } from "react";
import Link from "next/link";
import { CalendarClock, CheckCircle2, Plus } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { VorsorgeTrendStrip } from "@/components/measurement-reminders/vorsorge-trend-strip";
import {
  useMeasurementReminders,
  useMeasurementReminderMutations,
  type MeasurementReminder,
} from "@/hooks/use-measurement-reminders";

const DAY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_LIMIT = 3;

function relativeDueKey(
  nextDueAt: string | null,
  now: number,
): { key: string; days: number } {
  if (!nextDueAt) return { key: "nextDue.none", days: 0 };
  const deltaDays = Math.round((new Date(nextDueAt).getTime() - now) / DAY_MS);
  if (deltaDays < 0) return { key: "overdueByDays", days: Math.abs(deltaDays) };
  if (deltaDays === 0) return { key: "nextDue.today", days: 0 };
  if (deltaDays === 1) return { key: "nextDue.tomorrow", days: 1 };
  return { key: "nextDue.inDays", days: deltaDays };
}

function resolveLabel(
  reminder: MeasurementReminder,
  t: (key: string) => string,
): string {
  if (reminder.origin === "COACH") {
    const translated = t(reminder.label);
    return translated === reminder.label ? reminder.label : translated;
  }
  return reminder.label;
}

export function VorsorgeDashboardCard() {
  const { t } = useTranslations();
  const { data: reminders, isLoading } = useMeasurementReminders();
  const { satisfy } = useMeasurementReminderMutations();
  const [now] = useState(() => Date.now());
  const [capturing, setCapturing] = useState<MeasurementReminder | null>(null);
  const [captureFooterEl, setCaptureFooterEl] =
    useState<HTMLDivElement | null>(null);

  // Active reminders only (the manage toggles hide disabled ones from the
  // summary), most-urgent first as the API already sorts them.
  const upcoming = (reminders ?? [])
    .filter((r) => r.enabled)
    .slice(0, SUMMARY_LIMIT);

  function onPrimaryAction(reminder: MeasurementReminder) {
    if (reminder.measurementType) {
      setCapturing(reminder);
    } else {
      satisfy.mutate(reminder.id);
    }
  }

  function onCaptureSuccess() {
    const reminder = capturing;
    setCapturing(null);
    if (reminder) satisfy.mutate(reminder.id);
  }

  return (
    <Card data-slot="vorsorge-dashboard-card" className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <CalendarClock className="h-4 w-4" aria-hidden="true" />
          {t("measurementReminders.sectionTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : upcoming.length === 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              {t("measurementReminders.dashboard.empty")}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/vorsorge">
                {t("measurementReminders.dashboard.openLink")}
              </Link>
            </Button>
          </div>
        ) : (
          <ul className="space-y-2">
            {upcoming.map((reminder) => {
              const due = relativeDueKey(reminder.nextDueAt, now);
              const isLinked = reminder.measurementType != null;
              return (
                <li
                  key={reminder.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-2.5"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="truncate text-sm font-medium">
                      {resolveLabel(reminder, t)}
                    </p>
                    <Badge variant="secondary" className="text-xs">
                      {t(`measurementReminders.${due.key}`, { days: due.days })}
                    </Badge>
                    {/* v1.18.7 (Wave E) — discreet 7-day strip under the
                        metric context; renders nothing for a free-text
                        reminder or a too-thin window. */}
                    <VorsorgeTrendStrip
                      measurementType={reminder.measurementType}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0"
                    onClick={() => onPrimaryAction(reminder)}
                    disabled={satisfy.isPending}
                  >
                    {isLinked ? (
                      <>
                        <Plus className="h-4 w-4" />
                        {t("measurementReminders.captureValue")}
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-4 w-4" />
                        {t("measurementReminders.markDone")}
                      </>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <ResponsiveSheet
        open={capturing !== null}
        onOpenChange={(open) => {
          if (!open) setCapturing(null);
        }}
        title={t("measurementReminders.capture.title")}
        description={t("measurementReminders.capture.description")}
        footer={<div ref={setCaptureFooterEl} className="flex w-full" />}
      >
        {capturing && (
          <MeasurementForm
            defaultType={capturing.measurementType ?? undefined}
            onSuccess={onCaptureSuccess}
            onCancel={() => setCapturing(null)}
            footerSlot={captureFooterEl}
          />
        )}
      </ResponsiveSheet>
    </Card>
  );
}
