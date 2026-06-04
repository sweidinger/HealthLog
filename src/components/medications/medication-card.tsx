"use client";

import { useState, useEffect, useReducer } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MedicationCardHeader } from "@/components/medications/MedicationCardHeader";
import { MedicationCardMenu } from "@/components/medications/medication-card-menu";
import { MedicationStateBadges } from "@/components/medications/card-parts/medication-state-badges";
import { MedicationStatusPill } from "@/components/medications/card-parts/medication-status-pill";
import {
  MedicationComplianceBars,
  MedicationComplianceSkeleton,
} from "@/components/medications/card-parts/medication-compliance-bars";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import {
  MedicationNextLastSlot,
  useWeekdayLabel,
} from "@/components/medications/card-parts/medication-next-last-slot";
import { formatTimeWindowRange } from "@/lib/time-window-format";
import { formatDateTime, formatTime } from "@/lib/format";
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";
import {
  reduceCurrentWindowStatus,
  toBerlinDate,
} from "@/lib/medications/window-status";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import { LogInjectionSiteDialog } from "@/components/medications/log-injection-site-dialog";
import { useGlobalExcludedInjectionSites } from "@/lib/medications/use-injection-site-prefs";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";
import type { ComplianceDisplay } from "@/lib/analytics/compliance";

interface Schedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
}

interface Medication {
  id: string;
  name: string;
  dose: string;
  category: string;
  /**
   * v1.4.25 W4d — Prisma treatment-class discriminator. When set to
   * "GLP1" the parent should render the {@link Glp1MedicationCard}
   * variant instead of this generic card. The field is optional for
   * backwards compatibility with mocks.
   */
  treatmentClass?: string;
  dosesPerUnit?: number | null;
  /** v1.6.0 — route of administration (drives the injection-site prompt). */
  deliveryForm?: string;
  /** v1.8.5 — per-medication injection-site tracking opt-in. */
  trackInjectionSites?: boolean;
  /** v1.8.5 — per-medication allowed / preferred injection sites. */
  allowedInjectionSites?: string[];
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  lastTakenAt: string | null;
  todayEventCount?: number;
  /**
   * v1.8.4 — server-computed next due instant from `GET /api/medications`
   * (`computeNextDueAt` → the canonical recurrence engine, anchored on the
   * last intake). The card renders this directly instead of re-deriving the
   * timestamp client-side; the engine honours rolling / RRULE / one-shot
   * cadences that the legacy daysOfWeek-only walker ignored.
   */
  nextDueAt?: string | null;
  schedules: Schedule[];
}

interface ComplianceData {
  compliance7: {
    totalExpected: number;
    taken: number;
    skipped: number;
    missed: number;
    rate: number;
    streak: number;
  };
  compliance30: {
    rate: number;
  };
  /**
   * v1.8.6 — the two compliance windows scaled to the dosing cadence. The
   * card always shows two percentage rows; `shortDays` / `longDays` name the
   * windows and `short` / `long` carry their rates. Additive — older mocks
   * omit it, in which case the card falls back to the static 7-/30-day
   * `compliance7` / `compliance30` fields.
   */
  complianceDisplay?: ComplianceDisplay;
}

interface MedicationCardProps {
  medication: Medication;
  onEdit: (med: Medication) => void;
  /**
   * v1.7.1 — routes to the medication's full intake-history view
   * (`/medications/{id}/history`), mirroring the detail-header History
   * button. The parent owns the navigation.
   */
  onOpenHistory: (med: Medication) => void;
  /**
   * v1.7.1 — opens the shared `<AdvancedSettingsSheet>` (mounted by the
   * list page) for this medication, mirroring the detail-header sliders
   * button.
   */
  onOpenAdvanced: (med: Medication) => void;
}

export function MedicationCard({
  medication,
  onEdit,
  onOpenHistory,
  onOpenAdvanced,
}: MedicationCardProps) {
  const queryClient = useQueryClient();
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const weekdayLabel = useWeekdayLabel();
  const [intakeLoading, setIntakeLoading] = useState<string | null>(null);
  // v1.8.5 — post-dose injection-site prompt state. Holds the intake
  // event id returned by the take POST so the confirm handler can PATCH
  // the chosen site onto it. Null = dialog closed.
  const [siteIntakeId, setSiteIntakeId] = useState<string | null>(null);
  const globalExcluded = useGlobalExcludedInjectionSites();
  const tracksInjection =
    medication.deliveryForm === "INJECTION" &&
    medication.trackInjectionSites === true;

  const { data: compliance } = useQuery({
    queryKey: queryKeys.medicationCompliance(medication.id),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medication.id}/compliance`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as ComplianceData;
    },
    staleTime: 30 * 1000,
  });

  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  const { data: thresholds } = useQuery({
    queryKey: queryKeys.settingsReminderThresholds(),
    queryFn: async () => {
      const res = await fetch("/api/settings/reminder-thresholds");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as { lateMinutes: number; missedMinutes: number };
    },
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    const interval = setInterval(forceUpdate, 60_000);
    return () => clearInterval(interval);
  }, []);

  // v1.11.3 C2 — reverse the just-recorded intake via the soft-delete
  // route. Surfaced from the success toast's Undo action so a misclicked
  // take / skip no longer needs a history dive to correct.
  async function undoIntake(eventId: string) {
    try {
      const res = await fetch(
        `/api/medications/${medication.id}/intake/${eventId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        toast.error(t("medications.intakeUndoFailed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.intakeUndone"));
    } catch {
      toast.error(t("medications.intakeUndoFailed"));
    }
  }

  async function recordIntake(skipped: boolean) {
    const key = skipped ? "skip" : "take";
    setIntakeLoading(key);
    try {
      const res = await fetch(`/api/medications/${medication.id}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipped }),
      });
      // v1.11.3 C1 — a failed POST used to clear the spinner silently, so
      // the user believed the dose was logged when it was not. Surface the
      // failure and never show the success confirmation in that case.
      if (!res.ok) {
        toast.error(
          t("medications.intakeToastFailed", { name: medication.name }),
        );
        return;
      }
      // The POST returns the created event (`apiSuccess(event, 201)`); its
      // id drives both the Undo affordance and the optional injection-site
      // prompt below.
      let eventId: string | undefined;
      try {
        const json = await res.json();
        eventId = json?.data?.id as string | undefined;
      } catch {
        /* dose recorded; the body is best-effort for the id */
      }
      toast.success(
        t(
          skipped
            ? "medications.intakeToastSkipped"
            : "medications.intakeToastTaken",
          { name: medication.name },
        ),
        eventId
          ? {
              action: {
                label: t("medications.intakeUndo"),
                onClick: () => void undoIntake(eventId),
              },
            }
          : undefined,
      );
      await invalidateKeys(queryClient, medicationDependentKeys);
      // v1.8.5 — after a TAKEN dose on a tracking-enabled injection,
      // prompt (skippably) for the site. The dialog PATCHes it onto
      // the just-created event via the status-toggle route.
      if (!skipped && tracksInjection && eventId) {
        setSiteIntakeId(eventId);
      }
    } catch {
      toast.error(
        t("medications.intakeToastFailed", { name: medication.name }),
      );
    } finally {
      setIntakeLoading(null);
    }
  }

  async function confirmInjectionSite(site: InjectionSiteKey) {
    const intakeId = siteIntakeId;
    if (!intakeId) return;
    // v1.11.5 — keep the dialog open until the PATCH resolves. On failure
    // surface a toast and re-throw so the dialog stays mounted with the
    // chosen site instead of dismissing as though the site had been saved.
    const res = await fetch("/api/medications/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intakeId, status: "taken", injectionSite: site }),
    });
    if (!res.ok) {
      toast.error(t("medications.logInjectionSiteSaveFailed"));
      throw new Error("injection-site PATCH failed");
    }
    await invalidateKeys(queryClient, medicationDependentKeys);
    setSiteIntakeId(null);
  }

  // v1.8.6 — the two compliance windows scale with the dosing cadence. When
  // the server supplies `complianceDisplay` the card reads its cadence-scaled
  // rows; otherwise it falls back to the static 7-/30-day fields.
  const display = compliance?.complianceDisplay;
  const shortDays = display?.shortDays ?? 7;
  const longDays = display?.longDays ?? 30;
  const rate7 = display?.short.rate ?? compliance?.compliance7?.rate ?? 0;
  const rate30 = display?.long.rate ?? compliance?.compliance30?.rate ?? 0;
  const streak = display?.short.streak ?? compliance?.compliance7?.streak ?? 0;
  const categoryLabel = getMedicationCategoryLabel(medication.category, t);
  const sortedSchedules = [...medication.schedules].sort(
    (a, b) =>
      a.windowStart.localeCompare(b.windowStart) ||
      a.windowEnd.localeCompare(b.windowEnd),
  );
  const nowBerlin = toBerlinDate(new Date());
  // v1.8.4 — the next-due instant comes from the server (`nextDueAt`,
  // computed by the canonical recurrence engine anchored on the last
  // intake). The day label below derives from it; the window-range /
  // dose / label still come from the earliest configured schedule. The
  // legacy client-side daysOfWeek walker only ever read daysOfWeek +
  // windowStart and silently mis-anchored rolling / RRULE / one-shot
  // cadences, so it is gone.
  const nextDueMs = medication.nextDueAt
    ? new Date(medication.nextDueAt).getTime()
    : NaN;
  const nextAt = Number.isFinite(nextDueMs) ? nextDueMs : undefined;
  const nextSchedule = sortedSchedules[0] ?? null;

  const lateMinutes = thresholds?.lateMinutes ?? 120;
  const missedMinutes = thresholds?.missedMinutes ?? 240;

  const currentWindowStatus = reduceCurrentWindowStatus({
    schedules: sortedSchedules,
    nowBerlin,
    lateMinutes,
    missedMinutes,
    active: medication.active,
    lastTakenAt: medication.lastTakenAt,
    todayEventCount: medication.todayEventCount ?? 0,
  });

  function formatLastTakenAt(value: string): string {
    // Intentionally en-CA: gives YYYY-MM-DD which is locale-independent and
    // string-comparable for the today / yesterday / older bucketing below.
    // The actual user-facing display goes through formatTime / formatDateTime.
    const dayFormatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const intakeDay = dayFormatter.format(new Date(value));
    const todayDay = dayFormatter.format(now);
    const yesterdayDay = dayFormatter.format(yesterday);
    const time = formatTime(value);

    if (intakeDay === todayDay) return `${t("medications.today")}, ${time}`;
    if (intakeDay === yesterdayDay)
      return `${t("medications.yesterday")}, ${time}`;
    return formatDateTime(value);
  }

  const stateBadges = (
    <MedicationStateBadges
      notificationsEnabled={medication.notificationsEnabled}
      active={medication.active}
      pausedAt={medication.pausedAt}
    />
  );

  // v1.7.2 W3 — the four former header icon-buttons (open / edit /
  // history / advanced) collapse into a single overflow kebab. The card
  // header itself links to the detail page (the former chevron target).
  const headerActions = (
    <MedicationCardMenu
      onEdit={() => onEdit(medication)}
      onOpenHistory={() => onOpenHistory(medication)}
      onOpenAdvanced={() => onOpenAdvanced(medication)}
    />
  );

  return (
    <Card className={cn("h-full", medication.active ? "" : "opacity-60")}>
      <MedicationCardHeader
        name={medication.name}
        dose={medication.dose}
        categoryLabel={categoryLabel}
        stateBadges={stateBadges}
        actions={headerActions}
        href={`/medications/${medication.id}`}
        linkLabel={t("medications.openDetailPage")}
      />

      <CardContent className="flex h-full flex-col space-y-3.5">
        {/* Status, last & next intake info */}
        {currentWindowStatus.status && (
          <MedicationStatusPill
            status={currentWindowStatus.status}
            windowStart={currentWindowStatus.schedule!.windowStart}
            windowEnd={currentWindowStatus.schedule!.windowEnd}
          />
        )}

        {/* Next / last intake — rendered through the shared
            <MedicationNextLastSlot> so the generic and GLP-1 cards keep an
            identical slot (order, colour, spacing, gating, reserved
            min-height). The card owns only the *content* of each line; the
            wrapper + "Next / Last intake" labels live in the shared part. */}
        <MedicationNextLastSlot
          next={
            nextSchedule && currentWindowStatus.status !== "in_window"
              ? (() => {
                  const s = nextSchedule;

                  // Format day label relative to today
                  let dayLabel = "";
                  if (nextAt) {
                    const nextDate = toBerlinDate(new Date(nextAt));
                    const todayStr = `${nowBerlin.getFullYear()}-${nowBerlin.getMonth()}-${nowBerlin.getDate()}`;
                    const nextStr = `${nextDate.getFullYear()}-${nextDate.getMonth()}-${nextDate.getDate()}`;
                    const tomorrow = new Date(nowBerlin);
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    const tomorrowStr = `${tomorrow.getFullYear()}-${tomorrow.getMonth()}-${tomorrow.getDate()}`;

                    const diffDays = Math.round(
                      (nextDate.getTime() - nowBerlin.getTime()) /
                        (24 * 60 * 60 * 1000),
                    );

                    if (nextStr === todayStr) {
                      dayLabel = t("medications.today");
                    } else if (nextStr === tomorrowStr) {
                      dayLabel = t("medications.tomorrow");
                    } else if (diffDays <= 5) {
                      dayLabel = weekdayLabel(nextDate.getDay());
                    } else {
                      dayLabel = fmt.dateWithWeekday(nextDate);
                    }
                  }

                  return (
                    <>
                      {dayLabel && `${dayLabel}, `}
                      {formatTimeWindowRange(s.windowStart, s.windowEnd, locale)}
                      {s.label && (
                        <span className="hidden sm:inline"> ({s.label})</span>
                      )}
                      {s.dose && (
                        <span className="text-dose-accent hidden font-medium sm:inline">
                          {" "}
                          — {s.dose}
                        </span>
                      )}
                    </>
                  );
                })()
              : null
          }
          last={
            medication.lastTakenAt
              ? formatLastTakenAt(medication.lastTakenAt)
              : null
          }
        />

        {/* Compliance bars — always two rows. The server scales the two
            windows to the dosing cadence (7 / 30 days for dense meds,
            stepping up to 90 / 365 for sparse ones); the labels follow the
            chosen windows. A constant-height skeleton holds the slot while
            the per-card compliance query is in flight (or returns null) so
            the card body keeps a fixed footprint and the action row pins to
            the same baseline as its grid-row sibling. */}
        {medication.active &&
          (compliance ? (
            <MedicationComplianceBars
              rate7={rate7}
              rate30={rate30}
              streak={streak}
              shortDays={shortDays}
              longDays={longDays}
            />
          ) : (
            <MedicationComplianceSkeleton />
          ))}

        {/* Quick actions — primary buttons of the medication card. The
            content above reserves constant-height slots, so the card bodies
            in a grid row are equal height and `mt-auto` pins the action row
            to the same baseline without opening the void that an unequal-
            height pin produced before. */}
        {medication.active && (
          <div className="mt-auto pt-0">
            <MedicationIntakeActions
              intakeLoading={intakeLoading}
              onRecordIntake={recordIntake}
            />
          </div>
        )}
      </CardContent>

      {/* v1.8.5 — post-dose injection-site capture (optional, skippable). */}
      {tracksInjection && (
        <LogInjectionSiteDialog
          open={siteIntakeId !== null}
          medicationName={medication.name}
          allowedInjectionSites={
            (medication.allowedInjectionSites ?? []) as InjectionSiteKey[]
          }
          globalExcludedInjectionSites={globalExcluded}
          history={[]}
          onConfirm={confirmInjectionSite}
          onSkip={() => setSiteIntakeId(null)}
        />
      )}
    </Card>
  );
}
