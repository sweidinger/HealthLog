"use client";

import { useEffect, useReducer, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MedicationCardHeader } from "@/components/medications/MedicationCardHeader";
import { MedicationCardMenu } from "@/components/medications/medication-card-menu";
import { MedicationStateBadges } from "@/components/medications/card-parts/medication-state-badges";
import { MedicationStatusPill } from "@/components/medications/card-parts/medication-status-pill";
import { MedicationComplianceBars } from "@/components/medications/card-parts/medication-compliance-bars";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import { formatDateTime, formatTime } from "@/lib/format";
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";
import {
  nextInjectionSite,
  type InjectionSiteKey,
} from "@/lib/medications/injection-sites";
import { LogInjectionSiteDialog } from "@/components/medications/log-injection-site-dialog";
import { useGlobalExcludedInjectionSites } from "@/lib/medications/use-injection-site-prefs";
import {
  reduceCurrentWindowStatus,
  toBerlinDate,
} from "@/lib/medications/window-status";
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
   * v1.7.1 — routes to the medication's full intake-history view
   * (`/medications/{id}/history`), mirroring the generic medication card
   * and the detail-header History button. The parent owns the navigation.
   */
  onOpenHistory: (med: Glp1Medication) => void;
  /**
   * v1.7.1 — opens the shared `<AdvancedSettingsSheet>` (mounted by the
   * list page) for this medication, mirroring the generic medication card
   * and the detail-header sliders button.
   */
  onOpenAdvanced: (med: Glp1Medication) => void;
  onLogSideEffect?: (med: Glp1Medication) => void;
}

const DAY_KEYS = [
  "medications.daysSun",
  "medications.daysMon",
  "medications.daysTue",
  "medications.daysWed",
  "medications.daysThu",
  "medications.daysFri",
  "medications.daysSat",
] as const;

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
  const [intakeLoading, setIntakeLoading] = useState<string | null>(null);
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  // v1.8.5 — post-dose injection-site prompt (see medication-card.tsx).
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
    enabled: medication.active,
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

  async function recordIntake(skipped: boolean) {
    const key = skipped ? "skip" : "take";
    setIntakeLoading(key);
    try {
      const res = await fetch(`/api/medications/${medication.id}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipped }),
      });
      if (res.ok) {
        toast.success(
          t(
            skipped
              ? "medications.intakeToastSkipped"
              : "medications.intakeToastTaken",
            { name: medication.name },
          ),
        );
        await invalidateKeys(queryClient, medicationDependentKeys);
        // v1.8.5 — prompt (skippably) for the injection site on a taken
        // dose when tracking is enabled.
        if (!skipped && tracksInjection) {
          try {
            const json = await res.json();
            const eventId = json?.data?.id as string | undefined;
            if (eventId) setSiteIntakeId(eventId);
          } catch {
            /* dose recorded; the site prompt is best-effort */
          }
        }
      }
    } finally {
      setIntakeLoading(null);
    }
  }

  async function confirmInjectionSite(site: InjectionSiteKey) {
    const intakeId = siteIntakeId;
    setSiteIntakeId(null);
    if (!intakeId) return;
    const res = await fetch("/api/medications/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intakeId, status: "taken", injectionSite: site }),
    });
    if (res.ok) {
      await invalidateKeys(queryClient, medicationDependentKeys);
    } else {
      toast.error(t("medications.logInjectionSiteNoneAvailable"));
    }
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

  const recentInjections = details?.recentIntakes ?? [];
  const lastSite =
    recentInjections.find((i) => i.injectionSite)?.injectionSite ?? null;
  const recommendedNextSite = nextInjectionSite(
    recentInjections
      .map((r) => r.injectionSite)
      .filter(Boolean) as InjectionSiteKey[],
  );

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

  function nextInjectionLabel(): string {
    if (!next) return "—";
    if (next.daysAway === 0) return t("medications.glp1NextInjectionToday");
    if (next.daysAway === 1) return t("medications.glp1NextInjectionTomorrow");
    const dayName = t(DAY_KEYS[next.date.getDay()]);
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

      <CardContent className="space-y-3.5">
        {/* Take-now / overdue / very-overdue pill, shared with the
            generic medication card. The GLP-1 card historically
            omitted this row, which made Mounjaro feel different from
            Ramipril on the medications grid even though the underlying
            schedule contract is the same shape. */}
        {currentWindowStatus.status && (
          <MedicationStatusPill
            status={currentWindowStatus.status}
            windowStart={currentWindowStatus.schedule!.windowStart}
            windowEnd={currentWindowStatus.schedule!.windowEnd}
          />
        )}

        {/* Injection state — last + next. The reserved min-height keeps a
            card whose last-injection line is absent the same vertical
            footprint as one that renders both lines, matching the generic
            medication card's reserved last/next slot, so the dose rows line
            up across the grid. */}
        <div className="min-h-[2.75rem] space-y-1 text-sm">
          {medication.lastTakenAt && (
            <p className="text-muted-foreground">
              {lastSite
                ? t("medications.glp1LastInjectionWithSite", {
                    label: lastInjectionLabel() ?? "—",
                    site: t(`medications.site${siteSuffix(lastSite)}`),
                  })
                : t("medications.glp1LastInjection", {
                    label: lastInjectionLabel() ?? "—",
                  })}
            </p>
          )}
          <p className="text-foreground/85">
            {nextInjectionLabel()}
            {/* v1.4.37 W4b — purple dose accent on the upcoming
                schedule dose, byte-equivalent with the generic
                medication card. Schedule.dose can override the
                medication-level dose during titration, so we surface
                it here when set. Hidden below sm: to keep the narrow
                viewport row tight, matching the generic card. */}
            {schedule?.dose && (
              <span className="hidden font-medium text-purple-400 sm:inline">
                {" "}
                — {schedule.dose}
              </span>
            )}
          </p>
        </div>

        {/* Rotation hint — only when we have a last + recommended site
            different from it. The picker on the dashboard tile owns
            mode-switching; the card just nudges. */}
        {lastSite &&
          recommendedNextSite &&
          recommendedNextSite !== lastSite && (
            <div className="border-border/60 bg-muted/40 rounded-md border px-3 py-2 text-xs">
              <p className="text-muted-foreground">
                {t("medications.glp1RotationLast", {
                  site: t(`medications.site${siteSuffix(lastSite)}`),
                })}
              </p>
              <p className="text-foreground/90 font-medium">
                {t("medications.glp1RotationSuggested", {
                  site: t(`medications.site${siteSuffix(recommendedNextSite)}`),
                })}
              </p>
            </div>
          )}

        {/* v1.4.28 — the "Bestand" (inventory) surface retired from
            the GLP-1 card: both the inline pens-remaining summary line
            and the per-pen disclosure are gone. The iOS-consumed
            Glp1InventoryDTO slot on /api/medications/[id]/glp1 stays
            in the response shape; only the web mounts are gone. */}

        {/* Compliance bars — always two rows, shared with the generic
            card so the page grid stays harmonious. The server scales the
            two windows to the dosing cadence; most weekly GLP-1 injections
            land on the 30-/90-day rung where the bars stay meaningful. */}
        {medication.active && compliance && (
          <MedicationComplianceBars
            rate7={rate7}
            rate30={rate30}
            streak={streak}
            shortDays={shortDays}
            longDays={longDays}
          />
        )}

        {/* Primary actions row — shared with the generic medication
            card. The GLP-1-specific side-effect quick-log lives in the
            header-actions overflow (kebab), not this row, so Mounjaro
            and Ramipril share the canonical two-button primary row. The
            row sits directly after the content (the card still fills the
            grid cell via h-full, but the actions are not pushed to the
            bottom — that left a void between the content and the buttons). */}
        {medication.active && (
          <MedicationIntakeActions
            intakeLoading={intakeLoading}
            onRecordIntake={recordIntake}
          />
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
          history={
            recentInjections
              .map((r) => r.injectionSite)
              .filter(Boolean) as InjectionSiteKey[]
          }
          onConfirm={confirmInjectionSite}
          onSkip={() => setSiteIntakeId(null)}
        />
      )}
    </Card>
  );
}

/**
 * Map enum value → i18n suffix.  ABDOMEN_LEFT → "AbdomenLeft" so we can
 * lookup `medications.siteAbdomenLeft` etc. without a switch table.
 */
function siteSuffix(site: InjectionSiteKey): string {
  return site
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
