/**
 * UTC-anchored start-of-day truncation used by the measurement rollup
 * writer.
 *
 * The measurement rollup table stores TIMESTAMPTZ bucket starts.
 * Anchoring on the UTC calendar day (rather than the user's local day)
 * keeps the bucket key deterministic across timezone-shifting consumers
 * — the same convention `date_trunc('day', measured_at AT TIME ZONE
 * 'UTC')` would produce on the read side. The display surfaces re-bucket
 * into the user's timezone via `userDayKey()` from `./format`.
 *
 * v1.4.40 W-GHOSTS consolidated two byte-identical local copies into
 * this module so future writers cannot drift independently. Note the
 * mood rollup writer no longer anchors here: since v1.32.12 it keys on
 * the canonical per-row `MoodEntry.date` label, so a mood lands on the
 * user's own local day rather than the UTC day of `mood_logged_at`.
 */
export function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}
