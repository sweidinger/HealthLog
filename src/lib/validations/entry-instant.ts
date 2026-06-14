/**
 * Shared entry-instant plausibility bound (v1.17 W1b).
 *
 * Medication intake (v1.15.19 / v1.16.9) already rejects a `takenAt` that
 * lies in the future or implausibly far in the past, so the retro-add
 * dialog and a hand-rolled API call cannot insert a row a decade ahead or
 * a century behind. The data-portability audit found the other capture
 * paths — `Measurement.measuredAt` and `MoodEntry.moodLoggedAt` — accepted
 * arbitrary instants, future dates included.
 *
 * This module hoists the intake bound into one reusable validator every
 * timestamped capture path applies:
 *
 *   - **No future instants** beyond a small clock-skew tolerance
 *     (`ENTRY_INSTANT_CLOCK_SKEW_MS`, +5 min). A client clock running a
 *     few minutes fast is tolerated; a genuinely future-dated entry is a
 *     bug or an import error and is rejected.
 *   - **A sane past floor.** Entries before `ENTRY_INSTANT_FAR_PAST` (the
 *     start of 1900) are rejected — no real-world reading predates it, and
 *     the floor catches epoch-zero / corrupted-import timestamps. Callers
 *     that want a tighter window (medication intake keeps its five-year
 *     floor) pass `maxAgeMs` to clamp the past bound nearer to now.
 *
 * Pure helpers + a Zod `superRefine` factory so the same bound can sit on
 * any schema's instant field with a stable per-field error path.
 */
import type { z } from "zod/v4";

/** Tolerated future skew for a client clock running fast (5 minutes). */
export const ENTRY_INSTANT_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Absolute far-past floor: 1900-01-01T00:00:00Z. No genuine health reading
 * predates it; the floor rejects epoch-zero / corrupted-import instants.
 */
export const ENTRY_INSTANT_FAR_PAST = new Date("1900-01-01T00:00:00.000Z");

export interface EntryInstantBounds {
  /**
   * Optional tighter past window in milliseconds. When set, the past floor
   * is `max(ENTRY_INSTANT_FAR_PAST, now - maxAgeMs)` — medication intake
   * passes its five-year window here so a stale backdated dose is rejected
   * well before the 1900 floor.
   */
  maxAgeMs?: number;
  /** Clock anchor; defaults to `Date.now()`. Injectable for tests. */
  now?: number;
  /**
   * Optional override for the past-bound violation message. Lets a caller
   * keep an established wording (e.g. medication intake's "within the last
   * 5 years") so existing contracts / tests stay stable.
   */
  pastMessage?: string;
}

/**
 * `true` when `instant` is a plausible capture time: not in the future
 * beyond the skew tolerance, and not before the (optionally clamped) past
 * floor. Shared by the Zod refinements and any imperative caller.
 */
export function isPlausibleEntryInstant(
  instant: Date,
  bounds: EntryInstantBounds = {},
): boolean {
  const now = bounds.now ?? Date.now();
  const t = instant.getTime();
  if (Number.isNaN(t)) return false;
  if (t > now + ENTRY_INSTANT_CLOCK_SKEW_MS) return false;
  const floorMs =
    bounds.maxAgeMs !== undefined
      ? Math.max(ENTRY_INSTANT_FAR_PAST.getTime(), now - bounds.maxAgeMs)
      : ENTRY_INSTANT_FAR_PAST.getTime();
  if (t < floorMs) return false;
  return true;
}

/**
 * Attach the entry-instant bound to a `z.date()`-typed field via two
 * `.refine` calls so each violation carries its own message. Use on any
 * transformed ISO field after `.transform((s) => new Date(s))`.
 *
 * Re-reads `Date.now()` inside the refinements (not at schema-build time)
 * so a long-lived schema instance always validates against the current
 * clock.
 */
export function validateEntryInstant<T extends z.ZodType<Date>>(
  schema: T,
  bounds: Omit<EntryInstantBounds, "now"> = {},
): T {
  const pastMessage =
    bounds.pastMessage ??
    (bounds.maxAgeMs !== undefined
      ? "Timestamp is too far in the past"
      : "Timestamp must not predate 1900");
  return schema
    .refine((d) => d.getTime() <= Date.now() + ENTRY_INSTANT_CLOCK_SKEW_MS, {
      message: "Timestamp must not be in the future",
    })
    .refine(
      // Past-floor check ONLY — a future instant already fails the refine
      // above, and re-running the full plausibility predicate here would
      // make a future-dated value emit BOTH messages (the second being a
      // nonsensical "too far in the past"). Compare against the floor alone.
      (d) => d.getTime() >= pastFloorMs(bounds),
      { message: pastMessage },
    ) as T;
}

/** Resolve the effective past floor (ms) for the given bounds at call time. */
function pastFloorMs(bounds: Omit<EntryInstantBounds, "now">): number {
  if (bounds.maxAgeMs === undefined) return ENTRY_INSTANT_FAR_PAST.getTime();
  return Math.max(
    ENTRY_INSTANT_FAR_PAST.getTime(),
    Date.now() - bounds.maxAgeMs,
  );
}
