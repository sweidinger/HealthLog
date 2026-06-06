import { Flame } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

type Translate = ReturnType<typeof useTranslations>["t"];
type Formatters = ReturnType<typeof useFormatters>;

/**
 * v1.15.8 — build the dose-count caption shown after the percentage.
 *
 * Returns `taken / expected` (`4 / 12`) when both counts are known, the
 * pluralised `<expected> doses` string when only the denominator is on the
 * wire, and `null` when neither is available (older mocks / pre-display
 * fallback) so the caller renders nothing rather than an empty separator.
 */
function doseCount(
  t: Translate,
  fmt: Formatters,
  taken: number | undefined,
  expected: number | undefined,
): string | null {
  if (typeof expected !== "number") return null;
  if (typeof taken === "number") {
    return `${fmt.number(taken)} / ${fmt.number(expected)}`;
  }
  return t("medications.complianceDoses", { count: expected });
}

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
  /**
   * v1.15.8 — taken-dose count over the short window (numerator). Rendered
   * after the percentage as a `taken / expected` count so two identical
   * percentages stay distinguishable: a rolling weekly med reading 100% on
   * every window now shows `100% · 4 / 4` vs `100% · 52 / 52` instead of two
   * bare identical numbers that read as a stuck display.
   */
  takenShort?: number;
  /** v1.15.8 — expected-dose count over the short window (denominator). */
  expectedShort?: number;
  /** v1.15.8 — taken-dose count over the long window (numerator). */
  takenLong?: number;
  /** v1.15.8 — expected-dose count over the long window (denominator). */
  expectedLong?: number;
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
 * The streak flame uses the semantic `text-warning` token (an alias over
 * Dracula orange in dark mode, AA-safe on the light card). The generic card
 * historically drifted onto Tailwind stock `text-orange-400`, and the flame
 * later carried the raw `text-dracula-orange` palette token; v1.12.2 routes
 * it through the semantic vocabulary the rest of the status surface uses.
 */
export function MedicationComplianceBars({
  rate7,
  rate30,
  streak,
  shortDays = 7,
  longDays = 30,
  takenShort,
  expectedShort,
  takenLong,
  expectedLong,
}: MedicationComplianceBarsProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const shortLabel = t("medications.complianceWindow", { days: shortDays });
  const longLabel = t("medications.complianceWindow", { days: longDays });

  // v1.12.2 — route the rate through the locale number formatter and round
  // so a non-integer rate (e.g. 33.333) never leaks raw into the caption,
  // matching how every other percentage renders.
  const shortPct = fmt.number(Math.round(rate7));
  const longPct = fmt.number(Math.round(rate30));

  // v1.15.8 — the dose-count line rendered after each percentage. Shows the
  // taken-of-expected count when both are known (`4 / 12`), else the bare
  // expected count when only the denominator is on the wire (`12 Dosen`).
  // Two windows reading the same percentage stay distinguishable by their
  // counts, which is what an operator needs to trust the number.
  const shortCount = doseCount(t, fmt, takenShort, expectedShort);
  const longCount = doseCount(t, fmt, takenLong, expectedLong);

  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{shortLabel}</span>
          <span className="font-medium">
            {shortPct}%
            {shortCount && (
              <span className="text-muted-foreground ml-1.5 font-normal">
                · {shortCount}
              </span>
            )}
          </span>
        </div>
        {/* aria-label so the bar has an accessible name. */}
        <Progress value={rate7} className="h-2" aria-label={shortLabel} />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{longLabel}</span>
          <span className="font-medium">
            {longPct}%
            {longCount && (
              <span className="text-muted-foreground ml-1.5 font-normal">
                · {longCount}
              </span>
            )}
          </span>
        </div>
        <Progress value={rate30} className="h-2" aria-label={longLabel} />
      </div>

      {/* Streak flame — only mounted when there's a streak so an empty
          row doesn't leave a residual gap below the bars. */}
      {streak > 0 && (
        <div className="flex items-center gap-4 text-xs">
          <span className="text-warning flex items-center gap-1 font-medium">
            <Flame className="h-3.5 w-3.5" />
            {streak} {t("medications.dayStreak")}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Constant-height placeholder for the compliance block, shown while the
 * per-card `/compliance` query is in flight or returns null. Without it a
 * card whose compliance has not yet resolved is ~5rem shorter than a sibling
 * whose compliance loaded, so the two cards in a 2-col grid row jump to
 * unequal heights (transiently on first paint, persistently for any med
 * whose endpoint returns null). The skeleton mirrors the two-bar layout's
 * footprint so the card body keeps a constant inventory and the action row
 * pins to the same baseline across the row.
 *
 * The streak-flame row height is intentionally NOT reserved — the flame is
 * gated on `streak > 0` on the loaded card too, so reserving it would make
 * every streak-less card taller than its own loaded self.
 */
export function MedicationComplianceSkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="bg-muted h-4 w-20 rounded" />
          <span className="bg-muted h-4 w-9 rounded" />
        </div>
        <div className="bg-muted h-2 rounded" />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="bg-muted h-4 w-20 rounded" />
          <span className="bg-muted h-4 w-9 rounded" />
        </div>
        <div className="bg-muted h-2 rounded" />
      </div>
    </div>
  );
}
