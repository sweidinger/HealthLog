import { Flame } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { useTranslations } from "@/lib/i18n/context";

interface MedicationComplianceBarsProps {
  rate7: number;
  rate30: number;
  streak: number;
  /**
   * v1.8.6 — the span of the short row in days. The server scales the two
   * windows to the dosing cadence (7 / 30 for dense meds, stepping up to
   * 90 / 365 for sparse ones), so the labels follow the chosen windows
   * instead of a hardcoded 7 / 30. Defaults to 7 / 30 so older callers and
   * fixtures keep their prior labels.
   */
  shortDays?: number;
  /** v1.8.6 — the span of the long row in days. */
  longDays?: number;
}

/**
 * Shared two-row compliance bars plus the day-streak flame for the
 * medication cards. Extracted from the generic and GLP-1 cards so the bars
 * are structurally identical rather than hand-synced.
 *
 * v1.8.6 — the two windows scale with the dosing cadence. A daily med shows
 * 7-day / 30-day; a weekly med 30-day / 90-day; a rare injection up to a
 * 365-day long window. The labels are parametrised on the chosen day-counts
 * so each row names the window it actually covers.
 *
 * The streak flame uses the canonical `text-dracula-orange` warning/streak
 * token (globals.css). The generic card historically drifted onto Tailwind
 * stock `text-orange-400`; unifying here closes that token gap.
 */
export function MedicationComplianceBars({
  rate7,
  rate30,
  streak,
  shortDays = 7,
  longDays = 30,
}: MedicationComplianceBarsProps) {
  const { t } = useTranslations();

  const shortLabel = t("medications.complianceWindow", { days: shortDays });
  const longLabel = t("medications.complianceWindow", { days: longDays });

  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{shortLabel}</span>
          <span className="font-medium">{rate7}%</span>
        </div>
        {/* aria-label so the bar has an accessible name. */}
        <Progress value={rate7} className="h-2" aria-label={shortLabel} />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{longLabel}</span>
          <span className="font-medium">{rate30}%</span>
        </div>
        <Progress value={rate30} className="h-2" aria-label={longLabel} />
      </div>

      {/* Streak flame — only mounted when there's a streak so an empty
          row doesn't leave a residual gap below the bars. */}
      {streak > 0 && (
        <div className="flex items-center gap-4 text-xs">
          <span className="text-dracula-orange flex items-center gap-1 font-medium">
            <Flame className="h-3.5 w-3.5" />
            {streak} {t("medications.dayStreak")}
          </span>
        </div>
      )}
    </div>
  );
}
