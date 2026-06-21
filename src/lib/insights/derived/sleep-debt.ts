/**
 * v1.19.0 — rolling sleep-debt BALANCE (server-authoritative timing math).
 *
 * Sleep debt is the extra sleep the body still needs TONIGHT because of recent
 * undersleep. It is a running BALANCE over a short recent window, not a
 * fortnight-long sum of every deficit:
 *
 *   - a night below need ADDS its shortfall to the balance, and
 *   - a night above need PAYS THE BALANCE DOWN (catch-up sleep recovers debt),
 *   - the balance floors at 0 (you cannot bank surplus into negative debt) and
 *     caps at a sane maximum (the body cannot carry an unbounded debt).
 *
 * WHY THE OLD MODEL READ ~7 h FOR A NORMAL SLEEPER
 * ------------------------------------------------
 * The v1.17.0 model summed `max(0, need − asleep)` over the trailing 14 nights
 * with NO surplus credit inside the window. Catch-up sleep could only help by a
 * deficit night AGEING OUT — never by paying the balance down. So a user a
 * modest ~30 min short on most nights accrued 14 × 30 ≈ 420 min ≈ 7 h of
 * standing "debt" that never recovered while the pattern held, and a single
 * 10 h catch-up night did nothing. WHOOP reports ~1 h for the same sleeper
 * because WHOOP's sleep debt is the recent need-minus-got balance that recovers
 * as you sleep — extra sleep tonight reduces what you owe tomorrow. This module
 * now matches that semantics: a short recent window, surplus-credited, floored.
 *
 * WHY A RUNNING BALANCE AND NOT A SUM
 * -----------------------------------
 * A sum of deficits answers "how much sleep did I miss across the window" — a
 * historical total that grows with the window and ignores recovery. A running
 * balance answers "how much do I still OWE right now" — it shrinks the moment
 * you catch up, which is the actionable number a recovery surface wants and the
 * one WHOOP shows. Recovery is credited at a partial rate (`recoveryRate`,
 * default 0.5) because the body does not bank surplus sleep minute-for-minute:
 * Van Dongen et al. 2003, *Sleep* 26(2):117-126 show the recovery curve is
 * sub-linear — one long night recovers some, not all, accumulated deficit.
 *
 * WHY A 5-NIGHT WINDOW
 * --------------------
 * Sleep debt is a SHORT-horizon, recent signal: research on recovery from acute
 * restriction shows most of the rebound resolves within a few nights of
 * adequate sleep. Five nights is long enough that one rough night does not
 * dominate, short enough that a fortnight-old deficit no longer shapes today's
 * "what do I owe tonight" — matching the recent-nights horizon WHOOP uses.
 *
 * ONE ENGINE, NO DUPLICATION
 * --------------------------
 * This module is PURE — it consumes the canonical per-night `asleepMinutes` the
 * shared sleep engine (`reconstructSleepNights`) already produces and takes the
 * sleep `need` as a parameter (the caller resolves it via the one existing
 * `sleepNeedMinutes(ageYears)` table — there is no second need table here).
 * "actual" MUST be the canonical asleep total, never a divergent
 * reconstruction, so this figure can never contradict the dashboard / Sleep
 * Score / hypnogram for the same night. No Prisma, no I/O — the route, Coach
 * snapshot, doctor PDF, and iOS serializer all reuse it.
 *
 * Composition with the Sleep Score: Sufficiency (`scoreSufficiency`) is the
 * SINGLE-NIGHT view of `need − actual` expressed 0–100; this is the recent
 * recovering BALANCE of the same `need − actual`. Same inputs, two framings — a
 * timing/recovery signal, not a second sleep-adequacy score.
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
   * Rolling window length in nights. 5 is the recent-nights horizon a recovery
   * surface wants: long enough that a single bad night does not dominate, short
   * enough that a fortnight-old deficit no longer shapes today's balance.
   */
  windowNights?: number;
  /**
   * Minimum tracked nights before the balance is asserted. Below this the
   * result is a calm PARTIAL state ("still learning") rather than a confident
   * balance off a near-empty window.
   */
  minNights?: number;
  /**
   * Fraction of a night's surplus (asleep − need) that pays the running balance
   * DOWN. 0.5 encodes the sub-linear recovery curve (Van Dongen 2003): one long
   * night recovers some, not all, accrued deficit — surplus does not bank
   * minute-for-minute. Deficits still add at full weight.
   */
  recoveryRate?: number;
  /**
   * Per-night deficit cap (minutes). One catastrophic night (a 2-hour sleep, or
   * a missing-stage artefact) must not swamp the window; 180 min (3 h) is the
   * largest single-night shortfall that still reads as "a rough night" rather
   * than a data glitch.
   */
  maxNightlyDeficitMinutes?: number;
  /**
   * Balance cap (minutes). The body cannot carry an unbounded debt and beyond a
   * point more debt is not meaningfully more actionable — the message is the
   * same. 600 min (10 h) caps the running balance so the number stays legible
   * and a long gap of rough nights cannot mint an absurd total.
   */
  maxTotalDebtMinutes?: number;
}

const DEFAULTS: Required<SleepDebtOptions> = {
  windowNights: 5,
  minNights: 4,
  recoveryRate: 0.5,
  maxNightlyDeficitMinutes: 180,
  maxTotalDebtMinutes: 600,
};

/** Per-night detail, oldest → newest, for the trend strip / tooltip. */
export interface SleepDebtNightDetail {
  night: string;
  asleepMinutes: number;
  /**
   * Signed contribution to the running balance for the night, in minutes,
   * after caps: `+deficit` when short of need, `−recoveryRate·surplus` when
   * over need. The running balance applies these in order and floors at 0.
   */
  deltaMinutes: number;
}

export interface SleepDebtResult {
  /**
   * `partial` until `minNights` tracked nights exist — the calm "still
   * learning" state. `ready` once the window has enough nights to assert a
   * balance.
   */
  state: "partial" | "ready";
  /** Current sleep-debt balance in minutes over the window, after caps. */
  debtMinutes: number;
  /** The sleep need (minutes) used for the deficit — echoed for transparency. */
  needMinutes: number;
  /** Nights actually counted (≤ windowNights). */
  nightsCounted: number;
  /** The configured rolling window length in nights. */
  windowNights: number;
  /** `minNights` − `nightsCounted` while partial, else 0 — drives the nudge. */
  nightsUntilReady: number;
  /** Per-night signed deltas over the window, oldest → newest. */
  perNight: SleepDebtNightDetail[];
}

/**
 * Compute the rolling sleep-debt balance over the trailing window. Pure.
 *
 * `nights` may arrive in any order and span more than the window — the most
 * recent `windowNights` (by wake-day key) are taken. `needMinutes` is the
 * caller-resolved age-based need (`sleepNeedMinutes`); passing it in keeps this
 * module free of the need table and lets a test pin an exact value.
 *
 * The balance walks the window oldest → newest: each night adds its capped
 * deficit OR subtracts `recoveryRate` of its surplus, floored at 0 and capped
 * at `maxTotalDebtMinutes`. The returned `debtMinutes` is the balance AFTER the
 * most recent night — what the sleeper still owes right now.
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
  // perNight strip reads oldest → newest like every other trend surface — and
  // so the running balance applies nights in chronological order.
  const windowed = [...nights]
    .filter((n) => Number.isFinite(n.asleepMinutes) && n.asleepMinutes >= 0)
    .sort((a, b) => (a.night < b.night ? -1 : a.night > b.night ? 1 : 0))
    .slice(-opts.windowNights);

  let balance = 0;
  const perNight: SleepDebtNightDetail[] = windowed.map((n) => {
    const gap = safeNeed - n.asleepMinutes;
    let deltaMinutes: number;
    if (gap > 0) {
      // Short of need: add the shortfall, capped so one disaster night cannot
      // swamp the window.
      deltaMinutes = Math.min(gap, opts.maxNightlyDeficitMinutes);
    } else {
      // Over need: catch-up sleep pays the balance down at the recovery rate
      // (sub-linear — surplus does not bank minute-for-minute).
      deltaMinutes = gap * opts.recoveryRate;
    }
    balance = Math.max(
      0,
      Math.min(balance + deltaMinutes, opts.maxTotalDebtMinutes),
    );
    return {
      night: n.night,
      asleepMinutes: n.asleepMinutes,
      deltaMinutes,
    };
  });

  const nightsCounted = perNight.length;
  const debtMinutes = Math.round(balance);

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
