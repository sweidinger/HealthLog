/**
 * BP-in-target percentage helper.
 *
 * The "BD im Zielbereich" tile on the dashboard reports the share of
 * recent blood-pressure readings that fall inside the user's age-band
 * target zone. Up to v1.4.14 this lived inline in
 * `src/app/api/analytics/route.ts` and had two latent bugs that made
 * the tile read 0 % even when the user clearly had readings inside the
 * target band:
 *
 * 1. **Wrong denominator.** The legacy code divided `inTarget /
 *    sysData.length`, but readings are only countable when a matching
 *    diastolic exists within 5 minutes. So a user with 30 sys + 30 dia
 *    that all paired and 6 in target read `6/30 = 20 %` — but a user
 *    where only 10 of 30 sys had a matching dia inside 5 minutes (the
 *    other 20 were close-pair-less imports) capped at `<= 10/30 = 33 %`
 *    no matter what. Worse: when none paired, the numerator stayed 0
 *    so the tile reported a flat 0 %.
 *
 * 2. **No fallback when timestamps don't pair.** Withings imports and
 *    moodLog.app imports each write sys + dia as separate Measurement
 *    rows that ought to share a `measuredAt` to the second — but
 *    rounding through different timezones can drift them by minutes.
 *    The 5-minute window was tight; data imported with hour-level
 *    rounding (some legacy Withings ranges) had `timeDiff > 5 min` and
 *    the tile flat-lined to 0 %.
 *
 * Fix: pair sys + dia by **same Berlin calendar day** as a fallback if
 * the within-5-minutes pairing yields nothing, and always divide by the
 * count of *paired* readings (the denominator that gets a vote).
 *
 * Pure & deterministic so the unit test suite can pin the exact %.
 */
import type { BpTargets } from "./bp-targets";

export interface BpReading {
  measuredAt: Date;
  value: number;
}

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
    if (
      sys.value >= targets.sysLow &&
      sys.value <= targets.sysHigh &&
      match.dia.value >= targets.diaLow &&
      match.dia.value <= targets.diaHigh
    ) {
      inTarget += 1;
    }
  }

  if (pairs === 0) return null;

  return {
    pct: Math.round((inTarget / pairs) * 100),
    pairs,
  };
}
