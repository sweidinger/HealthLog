import { CalendarClock, CircleDashed } from "lucide-react";

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
 * next-intake slot at the top, so repeating it would be a duplicate. The same
 * reasoning retired the `missed` tier in v1.27.5 — an overdue dose already
 * escalates on the next-intake value line (the destructive "Überfällig" /
 * "Stark überfällig" row), so a second overdue line below the streak row
 * doubled the signal. Only the `due` tier (and the neutral no-closed-cycles
 * note) earns this line.
 *
 * Driven by `currentCycle.state` (`on_track` / `due` / `missed` / `none`) plus
 * `hasClosedCycles`. The due tier uses the warning tone + a Lucide glyph so
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

  // on_track — the next dose simply hasn't come round yet; the upcoming-dose
  // timing already reads on the card's next-intake slot at the top. missed —
  // the overdue escalation already reads on that same next-intake value line
  // (destructive tone + glyph), so a second overdue line here doubled it.
  // Both render nothing; only the due tier earns this line.
  if (cycle.state !== "due") return null;

  return (
    <p className="text-warning flex items-center gap-1.5 text-xs font-medium">
      <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />
      {t("medications.cycleDueToday")}
    </p>
  );
}
