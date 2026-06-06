import { AlertTriangle, CalendarClock, CircleDashed } from "lucide-react";

import type { CurrentCycle } from "@/lib/analytics/compliance";
import { useTranslations } from "@/lib/i18n/context";

interface MedicationCycleStatusProps {
  /** The open-cycle descriptor from `complianceDisplay.currentCycle`. */
  cycle: CurrentCycle;
}

/**
 * v1.14.0 — the open-cycle status line for the medication cards.
 *
 * The compliance percentage rows score CLOSED cycles. A sparse weekly /
 * rolling med (a GLP-1 injection) that is simply between doses has no scored
 * cycle in flight, so the percentage alone reads as a scary 0% / 100% that
 * says nothing about whether the user is actually on schedule. This line is
 * decoupled from the rate: it reports the open cycle's calm status — whether
 * the dose is due or overdue, or that there's not enough history to score yet.
 *
 * The calm `on_track` "next dose in N days" phrasing is intentionally NOT
 * rendered here: the upcoming-dose timing already reads on the card's
 * next-intake slot at the top, so repeating it would be a duplicate. Only the
 * actionable due / overdue tiers (and the neutral no-closed-cycles note) earn
 * this line.
 *
 * Driven by `currentCycle.state` (`on_track` / `due` / `missed` / `none`) plus
 * `hasClosedCycles`. Colour follows the same semantic ramp the status pill
 * uses (warning / destructive) and pairs every tier with a Lucide glyph so
 * colour-blind users can disambiguate — WCAG 1.4.1 (Use of Color). It
 * complements the compliance number; it does not replace it.
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

  // on_track — the next dose simply hasn't come round yet. The upcoming-dose
  // timing already reads on the card's next-intake slot at the top, so a second
  // "next dose in N days" line here is a duplicate. Render nothing for the
  // on-track case; only the actionable due / overdue tiers earn this line.
  if (cycle.state !== "missed" && cycle.state !== "due") return null;

  let tone: string;
  let icon: React.ReactNode;
  let label: string;

  if (cycle.state === "missed") {
    tone = "text-destructive";
    icon = <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />;
    label = t("medications.cycleOverdue");
  } else {
    // due
    tone = "text-warning";
    icon = <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />;
    label = t("medications.cycleDueToday");
  }

  return (
    <p className={`flex items-center gap-1.5 text-xs font-medium ${tone}`}>
      {icon}
      {label}
    </p>
  );
}
