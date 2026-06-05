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
 * Each card still builds the value *content* itself (the generic card emits a
 * day-label + window-range; the GLP-1 card emits a weekly-cadence string),
 * because the two cadences read differently — but the wrapper, order, colour,
 * label/value layout, and gating are now guaranteed identical. The GLP-1 card
 * overrides the left-column label with its appointment-phrased wording.
 *
 * Layout: when `labelled`, each line is a `flex justify-between` row with the
 * bold label pinned left and the value flush right (`text-right`), so the
 * label and the time read as two distinct columns rather than crammed onto
 * one run of text. The label truncates first on a narrow viewport; the value
 * (the time / cadence) never truncates.
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
   * When true the part renders each line as a two-column row: a bold label
   * pinned left and the value flush right. The generic card uses the default
   * oral "Next intake" / "Last intake" labels; the GLP-1 card overrides them
   * with its appointment-phrased labels (see `nextLabel` / `lastLabel`).
   * When false the line renders as a single full-width run of text.
   */
  labelled?: boolean;
  /**
   * Override for the left-column label on the next-line. Defaults to the
   * oral `medications.nextIntake` string. The GLP-1 card passes its own
   * "next appointment" wording so the value column carries only the time.
   */
  nextLabel?: React.ReactNode;
  /** Override for the left-column label on the last-line. */
  lastLabel?: React.ReactNode;
}

export function MedicationNextLastSlot({
  next,
  last,
  labelled = true,
  nextLabel,
  lastLabel,
}: MedicationNextLastSlotProps) {
  const { t } = useTranslations();

  return (
    <div className="min-h-[2.75rem] space-y-3.5 text-sm">
      {next &&
        (labelled ? (
          <div className="text-muted-foreground flex items-baseline justify-between gap-3">
            <span className="min-w-0 flex-shrink truncate font-medium">
              {nextLabel ?? t("medications.nextIntake")}
            </span>
            <span className="text-right">{next}</span>
          </div>
        ) : (
          <p className="text-muted-foreground">{next}</p>
        ))}
      {last &&
        (labelled ? (
          <div className="text-muted-foreground flex items-baseline justify-between gap-3">
            <span className="min-w-0 flex-shrink truncate font-medium">
              {lastLabel ?? t("medications.lastIntake")}
            </span>
            <span className="text-right">{last}</span>
          </div>
        ) : (
          <p className="text-muted-foreground">{last}</p>
        ))}
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
