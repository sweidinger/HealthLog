/**
 * v1.15.0 — symptom-by-phase pattern aggregation.
 *
 * The cycle-NATIVE counterpart to the phase×vitals crosstab: for each logged
 * symptom, where in the cycle does it cluster? Pure + DB-free — the gated
 * `/api/cycle/insights` route does the reads and the gender gate, then hands the
 * already-fetched per-day symptom keys + the phase-day map (built identically to
 * the calendar grid) to this function.
 *
 * Honest, never causal: a symptom is surfaced only once it has been logged on at
 * least `SYMPTOM_PHASE_MIN_DAYS` phase-labelled days, so a one-off entry never
 * produces a "pattern". The output reports the raw per-phase counts and the
 * dominant phase + its share, so the UI states "logged mostly in your luteal
 * phase (7 of 9 days)" — an observation, not a diagnosis.
 */
import type { CyclePhase } from "@/lib/cycle/types";

/** A symptom must appear on at least this many phased days to surface a pattern. */
export const SYMPTOM_PHASE_MIN_DAYS = 3;

/** Cap the surfaced rows so the card stays scannable (most-logged first). */
export const SYMPTOM_PHASE_MAX_ROWS = 10;

const PHASES: CyclePhase[] = ["MENSTRUAL", "FOLLICULAR", "OVULATORY", "LUTEAL"];

/** One day's logged symptom keys (presence only — severity is not needed here). */
export interface SymptomDay {
  date: string;
  keys: readonly string[];
}

export interface SymptomPhasePatternRow {
  symptomKey: string;
  /** Per-phase count of phase-labelled days this symptom was logged. */
  counts: Record<CyclePhase, number>;
  /** Total phase-labelled days the symptom was logged (sum of `counts`). */
  total: number;
  /** The phase the symptom clusters in most. */
  topPhase: CyclePhase;
  /** topPhase count / total, in [0,1] — how concentrated the pattern is. */
  topShare: number;
}

function emptyCounts(): Record<CyclePhase, number> {
  return { MENSTRUAL: 0, FOLLICULAR: 0, OVULATORY: 0, LUTEAL: 0 };
}

/**
 * Tally each symptom's occurrences by cycle phase across the window. Only days
 * that carry a phase label count (a symptom logged outside any cycle window is
 * ignored). Rows below the min-day floor are dropped; the rest sort by total
 * desc (ties broken by key for determinism) and cap at `SYMPTOM_PHASE_MAX_ROWS`.
 */
export function computeSymptomPhasePatterns(
  symptomDays: readonly SymptomDay[],
  phaseByDay: ReadonlyMap<string, CyclePhase>,
): SymptomPhasePatternRow[] {
  const byKey = new Map<string, Record<CyclePhase, number>>();

  for (const day of symptomDays) {
    const phase = phaseByDay.get(day.date);
    if (!phase) continue;
    for (const key of day.keys) {
      let counts = byKey.get(key);
      if (!counts) {
        counts = emptyCounts();
        byKey.set(key, counts);
      }
      counts[phase] += 1;
    }
  }

  const rows: SymptomPhasePatternRow[] = [];
  for (const [symptomKey, counts] of byKey) {
    const total = PHASES.reduce((s, p) => s + counts[p], 0);
    if (total < SYMPTOM_PHASE_MIN_DAYS) continue;
    // Dominant phase — deterministic tie-break by the fixed phase order.
    let topPhase: CyclePhase = PHASES[0];
    for (const p of PHASES) {
      if (counts[p] > counts[topPhase]) topPhase = p;
    }
    rows.push({
      symptomKey,
      counts,
      total,
      topPhase,
      topShare: counts[topPhase] / total,
    });
  }

  rows.sort(
    (a, b) => b.total - a.total || a.symptomKey.localeCompare(b.symptomKey),
  );
  return rows.slice(0, SYMPTOM_PHASE_MAX_ROWS);
}
