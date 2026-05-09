/**
 * BP-in-target percentage helper.
 *
 * The "BD im Zielbereich" tile on the dashboard reports the share of
 * recent blood-pressure readings that are at or below the user's
 * age-band ceiling. Up to v1.4.14 this lived inline in
 * `src/app/api/analytics/route.ts` and had two latent bugs that made
 * the tile read 0 % even when the user clearly had readings inside the
 * target band:
 *
 * 1. **Wrong denominator (v1.4.14).** The legacy code divided
 *    `inTarget / sysData.length`, but readings are only countable when
 *    a matching diastolic exists within 5 minutes. v1.4.15 A4 fixed the
 *    denominator to count only paired readings.
 *
 * 2. **Wrong target semantics (v1.4.15 -> v1.4.16 A2 regression).** The
 *    v1.4.15 fix kept the original "within narrow goal band" semantics:
 *    `sys >= sysLow && sys <= sysHigh && dia >= diaLow && dia <= diaHigh`.
 *    With ESH 2023 narrow targets (Sys 120-129, Dia 70-79 for under-65)
 *    this collapses to 0 % for healthy normotensive users whose
 *    readings sit BELOW the goal band — Marc's actual data has many
 *    readings like 117/79 (textbook normotensive, well-controlled) that
 *    were marked OUT of target because sys < 120. Users intuitively
 *    consider those readings *in target* — and so does clinical
 *    practice ("BP is well-controlled" = "at goal or below the goal
 *    ceiling, not implausibly hypotensive"). The v1.4.16 fix changes
 *    semantics from a narrow band to a one-sided ceiling check with a
 *    clinical floor for true hypotension:
 *
 *      in-target := sys >= 90 AND sys <= sysHigh
 *                  AND dia >= 50 AND dia <= diaHigh
 *
 *    The 90/50 floors are well below any plausible "normal-low" and
 *    flag symptomatic hypotension as out-of-target instead of silently
 *    counting it as good control.
 *
 * 3. **No fallback when timestamps don't pair (v1.4.15 fix).** Withings
 *    imports and moodLog.app imports each write sys + dia as separate
 *    Measurement rows that ought to share a `measuredAt` to the second
 *    — but rounding through different timezones can drift them by
 *    minutes. The 5-minute window was tight; data imported with
 *    hour-level rounding (some legacy Withings ranges) had `timeDiff >
 *    5 min`. The fallback to same-Berlin-day pairing covers that.
 *
 * Pure & deterministic so the unit test suite can pin the exact %.
 */
import type { BpTargets } from "./bp-targets";

export interface BpReading {
  measuredAt: Date;
  value: number;
}

/**
 * Clinical floors below which a reading is symptomatic hypotension and
 * NOT a desirable "well-controlled BP" outcome. Roughly mid-band
 * shock-onset thresholds; well below any reasonable normotensive
 * resting reading.
 */
const SYS_HYPOTENSION_FLOOR = 90;
const DIA_HYPOTENSION_FLOOR = 50;

const BERLIN_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function toBerlinDayKey(date: Date): string {
  // en-CA gives us the YYYY-MM-DD shape directly.
  return BERLIN_DAY_FORMATTER.format(date);
}

/**
 * Pair a systolic reading with its closest diastolic by absolute time
 * delta. Returns the time delta (ms) and the matched dia, or `null` if
 * the dia list is empty.
 */
function findClosestDia(
  sys: BpReading,
  diaSeries: BpReading[],
): { dia: BpReading; deltaMs: number } | null {
  if (diaSeries.length === 0) return null;
  let bestDia = diaSeries[0];
  let bestDelta = Math.abs(
    diaSeries[0].measuredAt.getTime() - sys.measuredAt.getTime(),
  );
  for (let i = 1; i < diaSeries.length; i++) {
    const candidate = diaSeries[i];
    const delta = Math.abs(
      candidate.measuredAt.getTime() - sys.measuredAt.getTime(),
    );
    if (delta < bestDelta) {
      bestDelta = delta;
      bestDia = candidate;
    }
  }
  return { dia: bestDia, deltaMs: bestDelta };
}

/**
 * `true` when a paired reading is at or below the upper bound for both
 * sys and dia, AND above the clinical hypotension floors. This is the
 * canonical "BP in target" definition shared across every call site
 * (dashboard tile, insight cards, AI snapshot, comprehensive endpoint,
 * targets endpoint). Exported so the other modules don't drift.
 */
export function isBpReadingInTarget(
  sys: number,
  dia: number,
  targets: BpTargets,
): boolean {
  return (
    sys >= SYS_HYPOTENSION_FLOOR &&
    sys <= targets.sysHigh &&
    dia >= DIA_HYPOTENSION_FLOOR &&
    dia <= targets.diaHigh
  );
}

/**
 * Compute the share (0-100, rounded to nearest integer) of paired BP
 * readings inside `targets` over the supplied series. Returns `null`
 * when no pairs can be formed (caller renders the tile as "no data"
 * instead of 0 %).
 *
 * Pairing strategy:
 *   1. For each sys reading, find the closest dia by absolute time
 *      delta.
 *   2. Accept the pair if `deltaMs <= 5 minutes` (legacy bound) — same
 *      session.
 *   3. Otherwise accept the pair if both share the same Berlin
 *      calendar day (handles imports rounded to the hour or to noon).
 *   4. Discard otherwise.
 *
 * Denominator is the number of accepted pairs, NOT `sysData.length` —
 * that was the v1.4.14 bug that made the tile read 0 % when imports
 * had drifted timestamps.
 *
 * In-target check is the one-sided ceiling defined by
 * `isBpReadingInTarget()` — see file-header comment for the rationale.
 */
export function computeBpInTargetPct(
  sysSeries: BpReading[],
  diaSeries: BpReading[],
  targets: BpTargets,
): { pct: number; pairs: number } | null {
  if (sysSeries.length === 0 || diaSeries.length === 0) return null;

  const SAME_SESSION_MS = 5 * 60 * 1000;
  let pairs = 0;
  let inTarget = 0;

  for (const sys of sysSeries) {
    const match = findClosestDia(sys, diaSeries);
    if (!match) continue;

    const sameSession = match.deltaMs <= SAME_SESSION_MS;
    const sameBerlinDay =
      !sameSession &&
      toBerlinDayKey(sys.measuredAt) === toBerlinDayKey(match.dia.measuredAt);

    if (!sameSession && !sameBerlinDay) continue;

    pairs += 1;
    if (isBpReadingInTarget(sys.value, match.dia.value, targets)) {
      inTarget += 1;
    }
  }

  if (pairs === 0) return null;

  return {
    pct: Math.round((inTarget / pairs) * 100),
    pairs,
  };
}
