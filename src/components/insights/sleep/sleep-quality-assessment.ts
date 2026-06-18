/**
 * v1.18.6 — deterministic, data-grounded sleep-quality assessment.
 *
 * The AI "Einschätzung" under the sleep-quality block reads "no assessment
 * yet / unavailable" until a provider has run (and never at all on an account
 * with no AI provider). That left the most universally useful read — the one
 * the user's OWN numbers already support — blank. This pure helper turns the
 * sleep-quality summaries that the section already has in hand into a short,
 * grounded sentence: it names the night-over-night averages and grades them
 * against recognised reference ranges, with NO provider call and NO recompute
 * of a stored value (it only reads the server-authoritative averages).
 *
 * Grading thresholds are the conventional consumer-sleep-platform bands:
 *   - Sleep efficiency: ≥ 85 % is the textbook "good sleeper" floor (AASM);
 *     ≥ 90 % is excellent, < 75 % is poor.
 *   - Performance / consistency / headline score: 0–100, graded on the
 *     standard 85 / 70 split most rings use (good / fair / low).
 * The copy is intentionally cautious — it describes, it never diagnoses.
 *
 * Kept free of React + i18n so the grading is unit-testable in isolation; the
 * component maps the returned shape onto localised strings.
 */

export type QualityGrade = "excellent" | "good" | "fair" | "low";

export interface SleepQualityMetricRead {
  /** Registry/measurement type, e.g. `SLEEP_EFFICIENCY`. */
  type: string;
  /** The averaged value the section already holds (avg30 ?? avg7 ?? latest). */
  value: number;
}

export interface SleepQualityFinding {
  type: string;
  value: number;
  grade: QualityGrade;
}

export interface SleepQualityAssessment {
  /** The lead metric the assessment opens on (best-known quality signal). */
  lead: SleepQualityFinding;
  /** The remaining graded metrics, most-informative first. */
  rest: SleepQualityFinding[];
  /** Worst grade across the present metrics — drives the closing nudge. */
  overall: QualityGrade;
}

/** Percent-scaled 0–100 metrics graded on the 90 / 85 / 70 ring split. */
const PERCENT_METRICS = new Set<string>([
  "SLEEP_SCORE",
  "SLEEP_PERFORMANCE",
  "SLEEP_CONSISTENCY",
]);

/** Efficiency uses the clinical 90 / 85 / 75 floors rather than the ring split. */
function gradeEfficiency(pct: number): QualityGrade {
  if (pct >= 90) return "excellent";
  if (pct >= 85) return "good";
  if (pct >= 75) return "fair";
  return "low";
}

function gradeScore(value: number): QualityGrade {
  if (value >= 90) return "excellent";
  if (value >= 85) return "good";
  if (value >= 70) return "fair";
  return "low";
}

/**
 * Grade one quality metric. Returns null for a metric the helper has no
 * recognised band for (e.g. raw disturbance counts or sleep-need minutes),
 * so the assessment never grades a value against a scale it does not fit.
 */
function gradeMetric(type: string, value: number): QualityGrade | null {
  if (type === "SLEEP_EFFICIENCY") return gradeEfficiency(value);
  if (PERCENT_METRICS.has(type)) return gradeScore(value);
  return null;
}

/** Worst grade wins — a single low signal pulls the overall read down. */
const GRADE_RANK: Record<QualityGrade, number> = {
  excellent: 3,
  good: 2,
  fair: 1,
  low: 0,
};

/**
 * Lead-metric preference: the headline score reads first when present, then
 * efficiency, then performance, then consistency. Keeps the opening sentence
 * anchored on the most holistic signal the night carries.
 */
const LEAD_ORDER = [
  "SLEEP_SCORE",
  "SLEEP_EFFICIENCY",
  "SLEEP_PERFORMANCE",
  "SLEEP_CONSISTENCY",
] as const;

/**
 * Build a deterministic assessment from the present quality metrics. Returns
 * null when none of the supplied metrics is gradable, so the caller falls back
 * to its existing copy rather than printing an empty read.
 */
export function buildSleepQualityAssessment(
  reads: readonly SleepQualityMetricRead[],
): SleepQualityAssessment | null {
  const findings: SleepQualityFinding[] = [];
  for (const r of reads) {
    if (!Number.isFinite(r.value)) continue;
    const grade = gradeMetric(r.type, r.value);
    if (grade == null) continue;
    findings.push({ type: r.type, value: r.value, grade });
  }
  if (findings.length === 0) return null;

  const leadIndex = (type: string): number => {
    const i = LEAD_ORDER.indexOf(type as (typeof LEAD_ORDER)[number]);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = [...findings].sort(
    (a, b) => leadIndex(a.type) - leadIndex(b.type),
  );

  const overall = sorted.reduce<QualityGrade>(
    (worst, f) => (GRADE_RANK[f.grade] < GRADE_RANK[worst] ? f.grade : worst),
    "excellent",
  );

  return {
    lead: sorted[0],
    rest: sorted.slice(1),
    overall,
  };
}
