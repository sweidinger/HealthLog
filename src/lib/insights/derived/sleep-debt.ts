/**
 * v1.17.0 — cumulative sleep debt (server-authoritative timing math).
 *
 * Sleep debt is the running shortfall between how much sleep a person NEEDS
 * and how much they actually got, accumulated over a rolling window. Per
 * night the deficit is `max(0, need − asleep)` — only undersleep accrues
 * debt; a night of catch-up sleep does NOT mint a negative deficit that
 * silently erases yesterday's shortfall (the body does not bank surplus sleep
 * minute-for-minute; Van Dongen et al. 2003, *Sleep* 26(2):117-126 show the
 * recovery curve is sub-linear). Catch-up instead pays the running debt DOWN
 * through the rolling window: as a deficit night ages out of the window it
 * stops contributing, so a stretch of full nights drains the debt toward zero.
 *
 * ONE ENGINE, NO DUPLICATION
 * --------------------------
 * This module is PURE — it consumes the canonical per-night `asleepMinutes`
 * the shared sleep engine (`reconstructSleepNights`) already produces and
 * takes the sleep `need` as a parameter (the caller resolves it via the one
 * existing `sleepNeedMinutes(ageYears)` table — there is no second need table
 * here). "actual" MUST be the canonical asleep total, never a divergent
 * reconstruction, so this figure can never contradict the dashboard / Sleep
 * Score / hypnogram for the same night. No Prisma, no I/O — the route, Coach
 * snapshot, doctor PDF, and iOS serializer all reuse it.
 *
 * Composition with the Sleep Score: Sufficiency (`scoreSufficiency`) is the
 * SINGLE-NIGHT view of `need − actual` expressed 0–100; this is the ROLLING
 * CUMULATIVE of the same `need − actual`. Same inputs, two framings — a
 * timing/trend signal, not a second sleep-adequacy score.
 */

/** One night's canonical asleep total, keyed by its wake day. */
export interface SleepDebtNight {
  /** Wake-day key (YYYY-MM-DD), user timezone — from the canonical engine. */
  night: string;
  /** Canonical time-asleep minutes for the night (`SleepNight.asleepMinutes`). */
  asleepMinutes: number;
}

/** Tunable knobs; every default is documented inline. */
export interface SleepDebtOptions {
  /**
   * Rolling window length in nights. 14 is the standard two-week sleep-debt
   * horizon used across the consumer-sleep literature — long enough that a
   * single bad night does not dominate, short enough that month-old debt no
   * longer shapes today's signal.
   */
  windowNights?: number;
  /**
   * Minimum tracked nights before the cumulative debt is asserted. Below this
   * the result is a calm PARTIAL state ("still learning") rather than a
   * confident total off a near-empty window — a one-night window would read a
   * single rough night as a fortnight of debt.
   */
  minNights?: number;
  /**
   * Per-night deficit cap (minutes). One catastrophic night (a 2-hour sleep,
   * or a missing-stage artefact) must not swamp a fortnight of otherwise-fine
   * sleep; 180 min (3 h) is the largest single-night shortfall that still
   * reads as "a rough night" rather than a data glitch.
   */
  maxNightlyDeficitMinutes?: number;
  /**
   * Cumulative-debt cap (minutes). Beyond a point more debt is not
   * meaningfully more actionable — the message is the same ("you are deeply
   * under-slept"). 1200 min (20 h) caps the headline so the bar / number
   * stays legible and a long gap of untracked-then-rough nights cannot mint
   * an absurd total.
   */
  maxTotalDebtMinutes?: number;
}

const DEFAULTS: Required<SleepDebtOptions> = {
  windowNights: 14,
  minNights: 7,
  maxNightlyDeficitMinutes: 180,
  maxTotalDebtMinutes: 1200,
};

/** Per-night deficit detail, oldest → newest, for the trend strip / tooltip. */
export interface SleepDebtNightDetail {
  night: string;
  asleepMinutes: number;
  /** `max(0, need − asleep)` after the per-night cap, in minutes. */
  deficitMinutes: number;
}

export interface SleepDebtResult {
  /**
   * `partial` until `minNights` tracked nights exist — the calm "still
   * learning" state. `ready` once the window has enough nights to assert a
   * cumulative debt.
   */
  state: "partial" | "ready";
  /** Cumulative sleep debt in minutes over the window, after caps. */
  debtMinutes: number;
  /** The sleep need (minutes) used for the deficit — echoed for transparency. */
  needMinutes: number;
  /** Nights actually counted (≤ windowNights). */
  nightsCounted: number;
  /** The configured rolling window length in nights. */
  windowNights: number;
  /** `minNights` − `nightsCounted` while partial, else 0 — drives the nudge. */
  nightsUntilReady: number;
  /** Per-night deficits over the window, oldest → newest. */
  perNight: SleepDebtNightDetail[];
}

/**
 * Compute cumulative sleep debt over the trailing window. Pure.
 *
 * `nights` may arrive in any order and span more than the window — the most
 * recent `windowNights` (by wake-day key) are taken. `needMinutes` is the
 * caller-resolved age-based need (`sleepNeedMinutes`); passing it in keeps
 * this module free of the need table and lets a test pin an exact value.
 */
export function computeSleepDebt(
  nights: readonly SleepDebtNight[],
  needMinutes: number,
  options: SleepDebtOptions = {},
): SleepDebtResult {
  const opts = { ...DEFAULTS, ...options };
  const safeNeed =
    Number.isFinite(needMinutes) && needMinutes > 0 ? needMinutes : 0;

  // Take the most recent `windowNights` by wake-day key. Sort ascending so the
  // perNight strip reads oldest → newest like every other trend surface.
  const windowed = [...nights]
    .filter((n) => Number.isFinite(n.asleepMinutes) && n.asleepMinutes >= 0)
    .sort((a, b) => (a.night < b.night ? -1 : a.night > b.night ? 1 : 0))
    .slice(-opts.windowNights);

  const perNight: SleepDebtNightDetail[] = windowed.map((n) => {
    const rawDeficit = Math.max(0, safeNeed - n.asleepMinutes);
    // Cap one catastrophic night so it cannot swamp the fortnight.
    const deficitMinutes = Math.min(rawDeficit, opts.maxNightlyDeficitMinutes);
    return {
      night: n.night,
      asleepMinutes: n.asleepMinutes,
      deficitMinutes,
    };
  });

  const nightsCounted = perNight.length;
  const rawDebt = perNight.reduce((sum, n) => sum + n.deficitMinutes, 0);
  const debtMinutes = Math.min(Math.round(rawDebt), opts.maxTotalDebtMinutes);

  const ready = nightsCounted >= opts.minNights && safeNeed > 0;
  return {
    state: ready ? "ready" : "partial",
    debtMinutes,
    needMinutes: safeNeed,
    nightsCounted,
    windowNights: opts.windowNights,
    nightsUntilReady: ready ? 0 : Math.max(0, opts.minNights - nightsCounted),
    perNight,
  };
}
