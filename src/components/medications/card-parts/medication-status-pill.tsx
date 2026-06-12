import { AlertCircle, AlertTriangle, CircleCheck } from "lucide-react";

import { formatTimeWindowRange } from "@/lib/time-window-format";
import { useTranslations } from "@/lib/i18n/context";
import type { MedicationWindowStatus } from "@/lib/medications/window-status";

interface MedicationStatusPillProps {
  /** Non-null window status; the caller guards `status &&` before rendering. */
  status: Exclude<MedicationWindowStatus, null>;
  windowStart: string;
  windowEnd: string;
  /**
   * v1.16.9 — day-scale last-dose context. Non-null when a dose was
   * already taken earlier in the cadence period (a weekly shot days
   * before its slot day, or the previous slot served late); the pill
   * then renders a calm factual "last dose {n} days ago" note instead
   * of the take-now / overdue prompt — prompting a full take on the
   * slot day would be a double-dose prompt. The value is the whole
   * local days since that take.
   */
  takenEarlyDaysAgo?: number | null;
  /**
   * v1.16.10 — compact variant for the table view's Status column:
   * suppresses the trailing window-range span so the cell stays one
   * short phrase. Tier logic, colours and glyphs are byte-identical
   * with the card pill — only the suffix is dropped.
   */
  compact?: boolean;
  /**
   * v1.16.11 — inline variant: renders a `<span>` root instead of the
   * block `<p>` so the pill can sit as the right-aligned VALUE of the
   * "next intake" row (the take-now prompt lives on that row now, not
   * on its own line above the slot). A `<p>` inside the row's `<span>`
   * would be invalid nesting.
   */
  inline?: boolean;
}

/**
 * Shared take-now / overdue / very-overdue status pill for the medication
 * cards. Pairs the colour token with a Lucide glyph so colour-blind users
 * (red-green) can disambiguate the three tiers — WCAG 1.4.1 (Use of Color).
 *
 * Extracted from the generic and GLP-1 cards so the pill markup is shared
 * structurally rather than kept byte-equivalent by hand.
 */
export function MedicationStatusPill({
  status,
  windowStart,
  windowEnd,
  takenEarlyDaysAgo = null,
  compact = false,
  inline = false,
}: MedicationStatusPillProps) {
  const { t, locale } = useTranslations();
  const Root = inline ? "span" : "p";

  // v1.16.11 — the inline (next-row) variant keeps its window-range
  // suffix visible on mobile: the suffix is the row's only time anchor
  // there, and hiding it left every prompt tier time-less below `sm`.
  // The standalone `<p>` contexts keep the legacy truncation.
  const suffixClass = inline
    ? "text-muted-foreground"
    : "text-muted-foreground hidden sm:inline";

  if (takenEarlyDaysAgo != null) {
    return (
      <Root className="text-sm">
        <span className="text-muted-foreground inline-flex items-center gap-1 font-medium">
          <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />
          {takenEarlyDaysAgo === 1
            ? t("medications.lastDoseYesterday")
            : t("medications.lastDoseDaysAgo", { count: takenEarlyDaysAgo })}
        </span>
        {!compact && (
          <span className={suffixClass}>
            {" "}
            — {formatTimeWindowRange(windowStart, windowEnd, locale)}
          </span>
        )}
      </Root>
    );
  }

  return (
    <Root className="text-sm">
      <span
        className={
          // v1.12.2 — converge the three tiers onto the semantic feedback
          // vocabulary (success / warning / destructive) so the medication
          // status surface stops mixing semantic + Dracula tokens. The pill
          // reads as the standard urgency ramp: in-window = success (green),
          // late = warning (amber), very-late = destructive (red). This drops
          // the lone `text-dracula-yellow` middle-tier stray.
          "inline-flex items-center gap-1 font-medium " +
          (status === "in_window"
            ? "text-success"
            : status === "late"
              ? "text-warning"
              : "text-destructive")
        }
      >
        {status === "in_window" ? (
          <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />
        ) : status === "late" ? (
          <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        {status === "in_window"
          ? t("medications.takeNow")
          : status === "late"
            ? t("medications.overdue")
            : t("medications.veryOverdue")}
      </span>
      {!compact && (
        <span className={suffixClass}>
          {" "}
          — {formatTimeWindowRange(windowStart, windowEnd, locale)}
        </span>
      )}
    </Root>
  );
}
