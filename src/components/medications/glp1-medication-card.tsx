"use client";

import { useEffect, useReducer, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { MedicationCardMenu } from "@/components/medications/medication-card-menu";
import { MedicationStateBadges } from "@/components/medications/card-parts/medication-state-badges";
import { MedicationCardBody } from "@/components/medications/card-parts/medication-card-body";
import { useMedicationIntake } from "@/components/medications/use-medication-intake";
import { useWeekdayLabel } from "@/components/medications/card-parts/medication-next-last-slot";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import { formatDateTime, formatTime } from "@/lib/format";
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";
import { type InjectionSiteKey } from "@/lib/medications/injection-sites";
import { LogInjectionSiteDialog } from "@/components/medications/log-injection-site-dialog";
import { useGlobalExcludedInjectionSites } from "@/lib/medications/use-injection-site-prefs";
import {
  reduceCurrentWindowStatus,
  toBerlinDate,
} from "@/lib/medications/window-status";
import { resolveDisplayedSlotInstant } from "@/components/medications/card-parts/displayed-slot-instant";
import type { ComplianceDisplay } from "@/lib/analytics/compliance";

/**
 * v1.4.25 W4d — GLP-1 medication card variant.
 *
 * Marc directive 2026-05-14: NO chart on the medication card. The card
 * stays text-rich (drug name + current dose, last/next injection,
 * injection-site rotation hint, side-effect quick-log). v1.4.28
 * retired the inline dose-history disclosure and the inventory
 * surface. Chart-only surfaces are the Dashboard tile + Insights
 * /medikamente sub-page.
 *
 * Renders inside the standard medications grid alongside generic
 * medication cards; visually mirrors `medication-card.tsx` so the page
 * stays harmonious — same Card shell, same header layout, same
 * compliance bars, same primary "Taken / Skipped" actions. The
 * GLP-1-specific rows sit between the dose line and the compliance
 * bars so the user reads top-down: drug → injection state → adherence.
 */

interface ScheduleLite {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
}

interface DoseChangeLite {
  id: string;
  effectiveFrom: string;
  doseValue: number;
  doseUnit: string;
  note: string | null;
}

interface IntakeLite {
  takenAt: string | null;
  injectionSite: InjectionSiteKey | null;
}

export interface Glp1Medication {
  id: string;
  name: string;
  dose: string;
  category: string;
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
   * (the canonical recurrence engine anchored on the last intake). The card
   * renders this directly so a rolling GLP-1 with an interval other than the
   * weekly default re-anchors correctly; the old client-side predictor only
   * walked a single hardcoded weekly day-of-week.
   */
  nextDueAt?: string | null;
  schedules: ScheduleLite[];
}

interface ComplianceData {
  compliance7: { rate: number; streak: number };
  compliance30: { rate: number };
  /**
   * v1.8.6 — the two compliance windows scaled to the dosing cadence. GLP-1
   * injections are commonly weekly, so this card's windows step up to the
   * 30-/90-day rung where the bars stay meaningful. Additive — older mocks
   * omit it, in which case the card falls back to the static 7-/30-day
   * fields.
   */
  complianceDisplay?: ComplianceDisplay;
}

interface DetailsResponse {
  doseChanges: DoseChangeLite[];
  recentIntakes: IntakeLite[];
  inventory: {
    pensRemaining: number | null;
    dosesRemaining: number | null;
    weeksOfSupply: number | null;
    lowStock: boolean;
  } | null;
}

interface Glp1MedicationCardProps {
  medication: Glp1Medication;
  onEdit: (med: Glp1Medication) => void;
  /**
   * v1.15.18 — navigates to the medication detail page's Verlauf tab
   * (`/medications/{id}?tab=verlauf`), mirroring the generic medication
   * card. The parent owns the navigation.
   */
  onOpenHistory: (med: Glp1Medication) => void;
  /**
   * v1.15.18 — navigates to the medication detail page's Erweitert tab
   * (`/medications/{id}?tab=erweitert`), the home of the dissolved
   * advanced settings.
   */
  onOpenAdvanced: (med: Glp1Medication) => void;
  onLogSideEffect?: (med: Glp1Medication) => void;
}

function diffDays(target: Date, from: Date): number {
  const ms =
    Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) -
    Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

/**
 * v1.8.4 — the next injection instant now comes from the server's
 * `nextDueAt` (the canonical recurrence engine, anchored on the last
 * intake). The legacy client-side predictor only handled a single
 * hardcoded weekly day-of-week and re-anchored at +7 days, so a rolling
 * GLP-1 with a non-weekly interval rendered the wrong date and never
 * advanced after an injection.
 */
function nextInjectionFromServer(
  nextDueAt: string | null | undefined,
  now: Date,
): { date: Date; daysAway: number } | null {
  if (!nextDueAt) return null;
  const date = new Date(nextDueAt);
  if (Number.isNaN(date.getTime())) return null;
  return { date, daysAway: Math.max(0, diffDays(date, now)) };
}

export function Glp1MedicationCard({
  medication,
  onEdit,
  onOpenHistory,
  onOpenAdvanced,
  onLogSideEffect,
}: Glp1MedicationCardProps) {
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const weekdayLabel = useWeekdayLabel();
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  // v1.8.5 — post-dose injection-site prompt (see medication-card.tsx).
  const [siteIntakeId, setSiteIntakeId] = useState<string | null>(null);
  const globalExcluded = useGlobalExcludedInjectionSites();
  const tracksInjection =
    medication.deliveryForm === "INJECTION" &&
    medication.trackInjectionSites === true;

  // v1.12.2 — take / skip + failure-toast (C1) + Undo (C2) come from the
  // SAME shared hook the generic card uses, closing the robustness gap
  // where a failed GLP-1 POST was swallowed silently and the success toast
  // carried no Undo. The card keeps its post-success injection-site prompt.
  const { intakeLoading, recordIntake } = useMedicationIntake({
    medication,
    onRecorded: (eventId, skipped) => {
      if (!skipped && tracksInjection && eventId) {
        setSiteIntakeId(eventId);
      }
    },
  });

  const { data: compliance } = useQuery({
    queryKey: queryKeys.medicationCompliance(medication.id),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medication.id}/compliance`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as ComplianceData;
    },
    // v1.15.20 — same 5-minute window as the generic card: dose actions
    // invalidate the key explicitly, so a short staleTime only re-fired
    // a request per card on every list visit.
    staleTime: 5 * 60 * 1000,
  });

  // v1.4.37 W4b — same reminder-thresholds source as the generic
  // medication card so the take-now / overdue / very-overdue pill
  // tiers identically on both surfaces.
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

  // Pull GLP-1-specific extras (dose history + recent injection sites +
  // pen inventory). Lives behind a dedicated endpoint so the standard
  // medications grid loads in parallel without paying for it.
  const { data: details } = useQuery({
    queryKey: queryKeys.medicationGlp1Details(medication.id),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${medication.id}/glp1`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as DetailsResponse;
    },
    staleTime: 60 * 1000,
  });

  // Re-render once a minute so the in-window / overdue pill tracks
  // wall-clock progress without a route reload — mirrors the generic
  // medication card's tick cadence.
  useEffect(() => {
    const interval = setInterval(forceUpdate, 60_000);
    return () => clearInterval(interval);
  }, []);

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

  const schedule = medication.schedules[0] ?? null;
  const now = new Date();
  const next = nextInjectionFromServer(medication.nextDueAt, now);
  // v1.8.6 — the two compliance windows scale with the dosing cadence. When
  // the server supplies `complianceDisplay` the card reads its cadence-scaled
  // rows; otherwise it falls back to the static 7-/30-day fields.
  const display = compliance?.complianceDisplay;
  const shortDays = display?.shortDays ?? 7;
  const longDays = display?.longDays ?? 30;
  const rate7 = display?.short.rate ?? compliance?.compliance7?.rate ?? 0;
  const rate30 = display?.long.rate ?? compliance?.compliance30?.rate ?? 0;
  const streak = display?.short.streak ?? compliance?.compliance7?.streak ?? 0;
  // v1.15.9 — the open dose's server-derived status drives the green
  // take-window highlight + the overdue / heavily-overdue top line, shared
  // verbatim with the generic card. Defaults to "upcoming" (calm).
  const doseStatus = display?.currentDose.status ?? "upcoming";

  // v1.4.37 W4b — symmetric take-now / overdue pill with the generic
  // card. Sort schedules by `windowStart` so the most-actionable
  // earliest window wins when multiple GLP-1 windows overlap (rare
  // today; the parity is what matters).
  const sortedSchedules = [...medication.schedules].sort(
    (a, b) =>
      a.windowStart.localeCompare(b.windowStart) ||
      a.windowEnd.localeCompare(b.windowEnd),
  );
  const nowBerlin = toBerlinDate(now);
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

  // v1.12.3 — slot instant of the injection this card is showing (the
  // open/overdue window, else the server's next-due). Threaded onto the
  // take / skip POST so the server records THIS dose deterministically
  // rather than snapping "now" to the nearest slot.
  const displayedSlot = resolveDisplayedSlotInstant({
    currentWindowStatus,
    nextDueAt: medication.nextDueAt,
    now,
  });

  // v1.15.9 — the recent-injection list now feeds ONLY the post-dose
  // injection-site dialog's rotation history; the card surface no longer
  // shows where the last shot landed. The operator: "where I injected
  // doesn't interest me." Site TRACKING / logging is unchanged everywhere
  // else (the picker, the detail history) — only the card line drops it.
  const recentInjections = details?.recentIntakes ?? [];

  function lastInjectionLabel(): string | null {
    if (!medication.lastTakenAt) return null;
    const d = new Date(medication.lastTakenAt);
    const days = diffDays(d, now);
    if (days === 0)
      return `${t("medications.today")}, ${formatTime(medication.lastTakenAt)}`;
    if (days === -1)
      return `${t("medications.yesterday")}, ${formatTime(medication.lastTakenAt)}`;
    return formatDateTime(medication.lastTakenAt);
  }

  function nextInjectionLabel(): string | null {
    if (!next) return null;
    if (next.daysAway === 0) return t("medications.glp1NextInjectionToday");
    if (next.daysAway === 1) return t("medications.glp1NextInjectionTomorrow");
    const dayName = weekdayLabel(next.date.getDay());
    const dateShort = fmt.dateShort(next.date);
    return t("medications.glp1NextInjectionDays", {
      label: `${dayName}, ${dateShort}`,
      days: next.daysAway,
    });
  }

  const stateBadges = (
    <MedicationStateBadges
      notificationsEnabled={medication.notificationsEnabled}
      active={medication.active}
      pausedAt={medication.pausedAt}
    />
  );

  // The four former header icon-buttons (open / edit / history /
  // advanced) collapse into a SINGLE overflow menu so the GLP-1 card
  // stays symmetric with the generic medication card. The card header
  // itself links to the detail page (the former chevron target). The
  // optional side-effect quick-log would fold in as a last menu item
  // when `onLogSideEffect` is wired, but the medications list page does
  // not wire it — side-effect logging lives on the detail page's
  // SideEffectsSection — so the menu renders the same items as the
  // generic card.
  const headerActions = (
    <MedicationCardMenu
      onEdit={() => onEdit(medication)}
      onOpenHistory={() => onOpenHistory(medication)}
      onOpenAdvanced={() => onOpenAdvanced(medication)}
      onLogSideEffect={
        onLogSideEffect ? () => onLogSideEffect(medication) : undefined
      }
    />
  );

  const categoryLabel = getMedicationCategoryLabel(medication.category, t);

  // The upcoming-injection line value. The card owns this VALUE content —
  // the liked relative-day phrasing ("Samstag 13.7. (in 7 Tagen)") — while
  // the structure / labels live in the shared body. The purple dose accent
  // is byte-equivalent with the generic card's.
  const nextLine =
    next && currentWindowStatus.status !== "in_window" ? (
      <>
        {nextInjectionLabel()}
        {schedule?.dose && (
          <span className="text-dose-accent hidden font-medium sm:inline">
            {" "}
            — {schedule.dose}
          </span>
        )}
      </>
    ) : null;

  // v1.15.9 — the last-injection line drops the injection-site display; it
  // now reads exactly like the generic card's last line (relative-day only).
  const lastLine = medication.lastTakenAt
    ? t("medications.glp1LastInjection", { label: lastInjectionLabel() ?? "—" })
    : null;

  return (
    <MedicationCardBody
      name={medication.name}
      dose={medication.dose}
      categoryLabel={categoryLabel}
      active={medication.active}
      href={`/medications/${medication.id}`}
      linkLabel={t("medications.openDetailPage")}
      stateBadges={stateBadges}
      headerActions={headerActions}
      windowStatus={
        currentWindowStatus.status
          ? {
              status: currentWindowStatus.status,
              windowStart: currentWindowStatus.schedule!.windowStart,
              windowEnd: currentWindowStatus.schedule!.windowEnd,
            }
          : null
      }
      doseStatus={doseStatus}
      nextLine={nextLine}
      lastLine={lastLine}
      compliance={
        compliance ? { rate7, rate30, streak, shortDays, longDays } : null
      }
      currentCycle={display?.currentCycle ?? null}
      intakeLoading={intakeLoading}
      onRecordIntake={(skipped) => recordIntake(skipped, displayedSlot)}
    >
      {/* v1.8.5 — post-dose injection-site capture (optional, skippable). */}
      {tracksInjection && (
        <LogInjectionSiteDialog
          open={siteIntakeId !== null}
          medicationName={medication.name}
          allowedInjectionSites={
            (medication.allowedInjectionSites ?? []) as InjectionSiteKey[]
          }
          globalExcludedInjectionSites={globalExcluded}
          history={
            recentInjections
              .map((r) => r.injectionSite)
              .filter(Boolean) as InjectionSiteKey[]
          }
          onConfirm={confirmInjectionSite}
          onSkip={() => setSiteIntakeId(null)}
        />
      )}
    </MedicationCardBody>
  );
}
