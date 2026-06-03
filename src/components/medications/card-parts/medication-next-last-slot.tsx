import { useTranslations } from "@/lib/i18n/context";

/**
 * Shared "next / last intake" middle slot for the medication cards.
 *
 * Extracted from the generic and GLP-1 cards so the slot is structurally
 * identical rather than hand-synced. Before extraction the two cards
 * diverged on every axis the eye reads in a 2-col grid row:
 *   - order: generic showed next-then-last; GLP-1 showed last-then-next;
 *   - colour: generic next-line was `text-muted-foreground`; GLP-1 was the
 *     brighter `text-foreground/85`;
 *   - spacing: generic `space-y-3.5`; GLP-1 `space-y-1`;
 *   - gating: generic only rendered the next-line when a schedule was due
 *     and the window was not currently open; GLP-1 always rendered it and
 *     printed a literal "—" placeholder.
 *
 * This part fixes the order (next then last), the colour
 * (`text-muted-foreground` on both lines), the spacing (`space-y-3.5`), and
 * the gating (the caller only passes `next` when it should render, and the
 * placeholder branch is gone). The reserved `min-h-[2.75rem]` keeps a card
 * whose last-dose line is absent the same vertical footprint as a sibling
 * that renders both lines, so the dose rows line up across the grid.
 *
 * Each card still builds the line *content* itself (the generic card emits a
 * day-label + window-range; the GLP-1 card emits a weekly-cadence prose
 * string), because the two cadences read differently — but the wrapper,
 * order, colour, and gating are now guaranteed identical.
 */
interface MedicationNextLastSlotProps {
  /**
   * The upcoming-intake line content, or null when there is nothing to show
   * (no schedule, the window is currently open, a one-shot already taken,
   * etc.). The caller owns the gating; this part never prints a placeholder.
   */
  next: React.ReactNode | null;
  /** The last-intake line content, or null when the med has never been taken. */
  last: React.ReactNode | null;
  /**
   * When true (the generic card) the part prepends the bold
   * "Next intake" / "Last intake" labels. The GLP-1 card passes its own
   * site-aware prose (whose i18n strings already read "Next injection …" /
   * "Last injection …"), so it opts out and supplies the full line content.
   * Either way the wrapper, order, colour, spacing, gating and reserved
   * min-height are identical.
   */
  labelled?: boolean;
}

export function MedicationNextLastSlot({
  next,
  last,
  labelled = true,
}: MedicationNextLastSlotProps) {
  const { t } = useTranslations();

  return (
    <div className="min-h-[2.75rem] space-y-3.5 text-sm">
      {next && (
        <p className="text-muted-foreground">
          {labelled && (
            <>
              <span className="font-medium">{t("medications.nextIntake")}</span>{" "}
            </>
          )}
          {next}
        </p>
      )}
      {last && (
        <p className="text-muted-foreground">
          {labelled && (
            <>
              <span className="font-medium">{t("medications.lastIntake")}</span>{" "}
            </>
          )}
          {last}
        </p>
      )}
    </div>
  );
}

const WEEKDAY_KEYS = [
  "medications.daysSun",
  "medications.daysMon",
  "medications.daysTue",
  "medications.daysWed",
  "medications.daysThu",
  "medications.daysFri",
  "medications.daysSat",
] as const;

/**
 * Single weekday-label helper shared by both medication cards. Before this
 * the generic card used the `medications.weekday{Monday…}` (full-name) key
 * family while the GLP-1 card used `medications.days{Mon…}` (abbreviated),
 * so the same weekday rendered "Monday" on one card and "Mon" on the other
 * in the same grid. Both now resolve to the abbreviated form, which keeps
 * the slot tight and consistent across types.
 *
 * @returns a function mapping a JS `Date.getDay()` value (0 = Sunday …
 * 6 = Saturday) to its localised abbreviated weekday name.
 */
export function useWeekdayLabel(): (dayIndex: number) => string {
  const { t } = useTranslations();
  return (dayIndex: number) => t(WEEKDAY_KEYS[dayIndex]);
}
