"use client";

import { type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MedicationCardHeader } from "@/components/medications/MedicationCardHeader";
import { MedicationStatusPill } from "@/components/medications/card-parts/medication-status-pill";
import {
  MedicationComplianceBars,
  MedicationComplianceError,
  MedicationComplianceSkeleton,
} from "@/components/medications/card-parts/medication-compliance-bars";
import { MedicationCycleStatus } from "@/components/medications/card-parts/medication-cycle-status";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import { MedicationNextLastSlot } from "@/components/medications/card-parts/medication-next-last-slot";
import { useTranslations } from "@/lib/i18n/context";
import type { CurrentCycle, DoseStatus } from "@/lib/analytics/compliance";
import type { MedicationWindowStatus } from "@/lib/medications/window-status";

/**
 * v1.15.9 — the ONE shared medication-card body.
 *
 * Both the generic `<MedicationCard>` and the `<Glp1MedicationCard>` render
 * THIS component for their entire card shell + body, so structure, vertical
 * rhythm, spacing tokens, section order and labels are byte-identical by
 * construction — they cannot drift. The variants own only the data and the
 * VALUE content of the next/last lines (a daily med shows a clock time, a
 * weekly GLP-1 shows the liked "Samstag 13.7. (in 7 Tagen)" relative-day
 * phrasing); everything structural lives here.
 *
 * This closes the recurring "the two cards look subtly different" failure.
 * The Ramipril-vs-Mounjaro bottom-spacing mismatch in particular is fixed by
 * sharing this single `CardContent` (`flex h-full flex-col space-y-3.5`) and
 * the single `mt-auto pt-0` action wrapper — there is no per-variant spacing
 * left to diverge.
 *
 * State-driven presentation:
 *   - The card surface itself is a CONSTANT neutral surface — dose status
 *     never tints the card background or border. A whole card washing green
 *     reads as "take it now everywhere" and drowns the page; status is shown
 *     ONLY through the discreet top line / pill below.
 *   - `on_time_window` → the discreet "Take now" pill (success-toned text +
 *     glyph), no card wash.
 *   - `overdue` → a calm top status line; `missed` (at / past the miss
 *     cutoff) escalates to "Stark überfällig" in the destructive tone — both
 *     are a single text line with an icon, not a surface tint.
 *   - `upcoming` / `taken_*` / `skipped` → no escalation; the card stays calm.
 */
export interface MedicationCardBodyProps {
  /** Medication name shown on the header's line 1. */
  name: string;
  /** Dose shown beside the name on line 1. */
  dose: string;
  /** Localised category label for the header badge. */
  categoryLabel: string;
  /** Whether the medication is active (greys out + hides the action row). */
  active: boolean;
  /** Detail-page link target for the header region. */
  href: string;
  /** Accessible label for the navigating header link. */
  linkLabel: string;
  /** State badges (without-notification / paused) for the header. */
  stateBadges: ReactNode;
  /** Overflow kebab for the header. */
  headerActions: ReactNode;

  /** Current take-window status pill props, or null when no window is open. */
  windowStatus: {
    status: Exclude<MedicationWindowStatus, null>;
    windowStart: string;
    windowEnd: string;
    /** v1.16.9 — day-scale last-dose context in whole days (see the pill). */
    takenEarlyDaysAgo?: number | null;
  } | null;

  /**
   * The open dose's server-derived {@link DoseStatus}. Drives the green
   * take-window highlight and the overdue / heavily-overdue top line.
   */
  doseStatus: DoseStatus;

  /** Upcoming-intake line value, or null when there is nothing to show. */
  nextLine: ReactNode | null;
  /** Last-intake line value, or null when the med has never been taken. */
  lastLine: ReactNode | null;

  /**
   * The resolved compliance block, or null while the per-card query is in
   * flight (the body then renders the constant-height skeleton).
   */
  compliance: {
    rate7: number;
    rate30: number;
    streak: number;
    shortDays: number;
    longDays: number;
  } | null;

  /**
   * True when the batched compliance query FAILED (post-retry). The body
   * then renders the quiet same-footprint error fallback instead of the
   * skeleton — a permanent skeleton reads as "still loading" forever,
   * while a failed read needs a visible (but calm) retry affordance.
   */
  complianceError?: boolean;
  /** Refetch the shared compliance query (the error fallback's retry). */
  onRetryCompliance?: () => void;

  /** The open-cycle descriptor, or null when the display block is absent. */
  currentCycle: CurrentCycle | null;

  /** "take" | "skip" while the matching request is in flight, else null. */
  intakeLoading: string | null;
  /** Record the displayed dose (the card binds the slot instant). */
  onRecordIntake: (skipped: boolean) => void;

  /** GLP-1 variant mounts its post-dose injection-site dialog here. */
  children?: ReactNode;
}

export function MedicationCardBody({
  name,
  dose,
  categoryLabel,
  active,
  href,
  linkLabel,
  stateBadges,
  headerActions,
  windowStatus,
  doseStatus,
  nextLine,
  lastLine,
  compliance,
  complianceError = false,
  onRetryCompliance,
  currentCycle,
  intakeLoading,
  onRecordIntake,
  children,
}: MedicationCardBodyProps) {
  const { t } = useTranslations();

  // Overdue escalation line: a dose past its on-time window. `missed` (at /
  // past the clinical miss cutoff) reads "Stark überfällig"; the still-takeable
  // `overdue` tail reads the calmer "Überfällig". Both use the destructive
  // tone so the urgency is unmistakable; suppressed on an inactive med.
  const overdueLabel =
    active && doseStatus === "missed"
      ? t("medications.veryOverdue")
      : active && doseStatus === "overdue"
        ? t("medications.overdue")
        : null;

  return (
    <Card
      // The card surface is a constant neutral surface — dose status is never
      // expressed as a background / border tint (the maintainer, recurring): only the
      // discreet status line / pill below communicates take-now / overdue.
      className={cn("h-full", active ? "" : "opacity-60")}
    >
      <MedicationCardHeader
        name={name}
        dose={dose}
        categoryLabel={categoryLabel}
        stateBadges={stateBadges}
        actions={headerActions}
        href={href}
        linkLabel={linkLabel}
      />

      <CardContent className="flex h-full flex-col space-y-3.5">
        {/* Top status line. The in-window take-now pill (success) and the
            overdue escalation are mutually exclusive — a dose is either still
            in its take-window or past it. The overdue line wins when present
            so a heavily-overdue dose reads loud at the top of the card.
            The slot keeps a constant one-line height even when empty: the
            overdue tier arrives with the compliance query, and a line
            popping in late used to shift every row below it (CLS). */}
        <div className="min-h-5">
          {windowStatus?.takenEarlyDaysAgo != null ? (
            // v1.16.9 — last-dose context outranks the overdue line: a
            // day-scale dose already taken earlier in its period must never
            // escalate into a take prompt (double-dose risk).
            <MedicationStatusPill
              status={windowStatus.status}
              windowStart={windowStatus.windowStart}
              windowEnd={windowStatus.windowEnd}
              takenEarlyDaysAgo={windowStatus.takenEarlyDaysAgo}
            />
          ) : overdueLabel ? (
            <p className="text-destructive flex items-center gap-1 text-sm font-medium">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
              {overdueLabel}
            </p>
          ) : windowStatus ? (
            <MedicationStatusPill
              status={windowStatus.status}
              windowStart={windowStatus.windowStart}
              windowEnd={windowStatus.windowEnd}
            />
          ) : null}
        </div>

        {/* Next / last intake — the two decisive lines, each shown once. */}
        <MedicationNextLastSlot next={nextLine} last={lastLine} />

        {/* Compliance bars — always two rows; constant-height skeleton holds
            the slot while the query is in flight so the grid row stays even.
            A FAILED query swaps the skeleton for the same-footprint quiet
            error fallback (no bars, one notice line + retry) instead of
            sitting on the skeleton forever. */}
        {active &&
          (compliance ? (
            <MedicationComplianceBars
              rate7={compliance.rate7}
              rate30={compliance.rate30}
              streak={compliance.streak}
              shortDays={compliance.shortDays}
              longDays={compliance.longDays}
            />
          ) : complianceError && onRetryCompliance ? (
            <MedicationComplianceError onRetry={onRetryCompliance} />
          ) : (
            <MedicationComplianceSkeleton />
          ))}

        {/* Open-cycle status line — calm, rate-decoupled. The slot reserves
            one xs text line on every active card: the descriptor rides the
            compliance query, and a line appearing after the fetch resolved
            used to grow the card and shift the grid row (CLS). */}
        {active && (
          <div className="min-h-4">
            {currentCycle && <MedicationCycleStatus cycle={currentCycle} />}
          </div>
        )}

        {/* Quick actions — bottom-pinned so the action rows align across a
            grid row regardless of how much content sits above. */}
        {active && (
          <div className="mt-auto pt-0">
            <MedicationIntakeActions
              intakeLoading={intakeLoading}
              onRecordIntake={onRecordIntake}
            />
          </div>
        )}
      </CardContent>

      {children}
    </Card>
  );
}
