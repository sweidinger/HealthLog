/**
 * Query keys — cycle tracking: calendar windows, history, profile,
 * prefs, insights, day logs, and custom symptoms.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const cycleKeys = {
  /**
   * v1.15.0 — cycle-tracking surfaces. `cycle()` is the root prefix every
   * cycle write invalidates through (`cycleDependentKeys` in `./index.ts`).
   * The calendar read is keyed by `(from, to)` so paging the month strip
   * caches each window independently; the history + profile reads each get
   * their own slot. A day-log / period write evicts the whole `["cycle"]`
   * prefix so the calendar, the wheel, the predictions panel, and the
   * history stats repaint in lockstep.
   */
  cycle: () => ["cycle"] as const,
  cycleCalendar: (from: string, to: string) =>
    ["cycle", "calendar", from, to] as const,
  cycleHistory: (limit: number) => ["cycle", "history", limit] as const,
  cycleProfile: () => ["cycle", "profile"] as const,
  /** The UNGATED enable/prefs read (`/api/auth/me/cycle-prefs`) — the settings
   * on-ramp reads this so a non-FEMALE account can opt in before the gated
   * cycle page is reachable. */
  cyclePrefs: () => ["cycle", "prefs"] as const,
  cycleInsights: () => ["cycle", "insights"] as const,
  cycleDayLog: (date: string) => ["cycle", "day-log", date] as const,
  /** The caller's own custom symptoms (decrypted labels) the log-day sheet
   * merges into the seeded chip grid. */
  cycleCustomSymptoms: () => ["cycle", "custom-symptoms"] as const,
};
