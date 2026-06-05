import { AlertTriangle, CalendarClock, CircleCheck, CircleDashed } from "lucide-react";

import type { CurrentCycle } from "@/lib/analytics/compliance";
import { useTranslations } from "@/lib/i18n/context";
import { toBerlinDate } from "@/lib/medications/window-status";

interface MedicationCycleStatusProps {
  /** The open-cycle descriptor from `complianceDisplay.currentCycle`. */
  cycle: CurrentCycle;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole-day delta between two instants, measured on the user's calendar
 * (Europe/Berlin) so "in 2 days" lines up with the day a sparse dose lands on
 * rather than a raw 48-hour count. Positive = future, 0 = today, negative =
 * past. Mirrors the day-bucketing the card already does for its next/last slot.
 */
function calendarDayDelta(target: Date, now: Date): number {
  const a = toBerlinDate(target);
  const b = toBerlinDate(now);
  const targetMidnight = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const nowMidnight = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((targetMidnight.getTime() - nowMidnight.getTime()) / DAY_MS);
}

/**
 * v1.14.0 — the open-cycle status line for the medication cards.
 *
 * The compliance percentage rows score CLOSED cycles. A sparse weekly /
 * rolling med (a GLP-1 injection) that is simply between doses has no scored
 * cycle in flight, so the percentage alone reads as a scary 0% / 100% that
 * says nothing about whether the user is actually on schedule. This line is
 * decoupled from the rate: it reports the open cycle's calm status — when the
 * next dose lands, whether it's due or overdue, or that there's not enough
 * history to score yet.
 *
 * Driven by `currentCycle.state` (`on_track` / `due` / `missed` / `none`) plus
 * `hasClosedCycles`. Colour follows the same semantic ramp the status pill
 * uses (success / warning / destructive) and pairs every tier with a Lucide
 * glyph so colour-blind users can disambiguate — WCAG 1.4.1 (Use of Color).
 * It complements the compliance number; it does not replace it.
 */
export function MedicationCycleStatus({ cycle }: MedicationCycleStatusProps) {
  const { t } = useTranslations();

  // No projected next dose (PRN, paused, ended) → render nothing; the card
  // keeps its existing inventory.
  if (cycle.state === "none") return null;

  // Neutral "not enough history yet" wins over the relative phrasing: a
  // brand-new sparse med has a next dose but no closed cycle to anchor the
  // percentage rows, so we say so plainly rather than implying a score.
  if (!cycle.hasClosedCycles) {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <CircleDashed className="size-3.5 shrink-0" aria-hidden="true" />
        {t("medications.cycleNoClosedCycles")}
      </p>
    );
  }

  let tone: string;
  let icon: React.ReactNode;
  let label: string;

  if (cycle.state === "missed") {
    tone = "text-destructive";
    icon = <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />;
    label = t("medications.cycleOverdue");
  } else if (cycle.state === "due") {
    tone = "text-warning";
    icon = <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />;
    label = t("medications.cycleDueToday");
  } else {
    // on_track — the next dose simply hasn't come round yet.
    tone = "text-success";
    icon = <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />;
    const now = new Date();
    const days = cycle.nextDueAt
      ? calendarDayDelta(cycle.nextDueAt, now)
      : null;
    if (days === null || days <= 0) {
      // on_track with the slot today (now < dueAt but same calendar day).
      label = t("medications.cycleNextDoseToday");
    } else if (days === 1) {
      label = t("medications.cycleNextDoseTomorrow");
    } else {
      label = t("medications.cycleNextDoseInDays", { days });
    }
  }

  return (
    <p className={`flex items-center gap-1.5 text-xs font-medium ${tone}`}>
      {icon}
      {label}
    </p>
  );
}
