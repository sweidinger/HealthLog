/**
 * Coach evaluation grader (B0, v1.21.3).
 *
 * Grades a {prose, toolPayloads} capture against a golden case's
 * behaviour-anchored criteria. Each criterion is BINARY and weighted: a
 * `mustInclude` passes when its matcher finds the behaviour; a `mustAvoid`
 * passes when its matcher does NOT. The case passes when the earned weight
 * meets the threshold (default: every criterion must pass — these are floors,
 * not soft scores).
 *
 * This extends the prose grounding from numbers → structured claims: the
 * matchers a case supplies are the high-precision claim detectors from
 * `coach-prose-grounding.ts` (own-baseline, honesty-hedge, confident-verdict,
 * population-norm) plus the numeric `findUnverifiedCoachNumbers` floor. The
 * grader is deliberately a thin, deterministic dispatcher over those detectors;
 * the open-ended remainder (tone, nuance, partial claims) is the live judge's
 * job, never this one.
 *
 * `coach.eval.score` wide-event: the grader annotates one event per graded
 * case so a future dashboard can track the floor over time. The action name
 * follows the `<surface>.<noun>.<verb>` convention.
 */
import { annotate } from "@/lib/logging/context";
import type { CoachEvalCase, CoachEvalCriterion } from "./golden-cases";
import type { CoachCaseCapture } from "./run-case";

/** Result of one criterion. */
export interface CriterionResult {
  label: string;
  kind: CoachEvalCriterion["kind"];
  weight: number;
  passed: boolean;
}

/** Result of grading one case. */
export interface CaseGrade {
  id: string;
  taxonomy: CoachEvalCase["taxonomy"];
  /** Earned weight (sum of passing criteria weights). */
  earned: number;
  /** Total weight (sum of all criteria weights). */
  total: number;
  /** True when the case meets its pass threshold. */
  passed: boolean;
  /** Per-criterion breakdown. */
  criteria: CriterionResult[];
}

/** Run one criterion's matcher against the capture. */
function evaluateMatcher(
  criterion: CoachEvalCriterion,
  capture: CoachCaseCapture,
): boolean {
  const { matcher } = criterion;
  if (typeof matcher === "string") {
    return capture.prose.toLowerCase().includes(matcher.toLowerCase());
  }
  if (matcher instanceof RegExp) {
    return matcher.test(capture.prose);
  }
  return matcher(capture.prose, capture.toolPayloads);
}

/**
 * Grade a single capture against a case. `threshold` is the fraction of total
 * weight that must be earned to pass; the default is 1 (every floor must hold).
 */
export function gradeCase(
  testCase: CoachEvalCase,
  capture: CoachCaseCapture,
  threshold = 1,
): CaseGrade {
  const criteria: CriterionResult[] = [];
  let earned = 0;
  let total = 0;

  for (const criterion of testCase.criteria) {
    total += criterion.weight;
    const found = evaluateMatcher(criterion, capture);
    // mustInclude passes when found; mustAvoid passes when NOT found.
    const passed = criterion.kind === "mustInclude" ? found : !found;
    if (passed) earned += criterion.weight;
    criteria.push({
      label: criterion.label,
      kind: criterion.kind,
      weight: criterion.weight,
      passed,
    });
  }

  const passed = total === 0 ? true : earned / total >= threshold;

  annotate({
    action: { name: "coach.eval.score" },
    meta: {
      caseId: testCase.id,
      taxonomy: testCase.taxonomy,
      earned,
      total,
      passed,
    },
  });

  return {
    id: testCase.id,
    taxonomy: testCase.taxonomy,
    earned,
    total,
    passed,
    criteria,
  };
}

/** Summary of grading a whole set. */
export interface SetGrade {
  total: number;
  passed: number;
  failed: number;
  grades: CaseGrade[];
}

/** Grade an array of captures against their cases. */
export function gradeSet(
  cases: ReadonlyArray<CoachEvalCase>,
  captures: ReadonlyArray<CoachCaseCapture>,
  threshold = 1,
): SetGrade {
  const byId = new Map(captures.map((c) => [c.id, c]));
  const grades: CaseGrade[] = [];
  for (const testCase of cases) {
    const capture = byId.get(testCase.id);
    if (!capture) continue;
    grades.push(gradeCase(testCase, capture, threshold));
  }
  const passed = grades.filter((g) => g.passed).length;
  return {
    total: grades.length,
    passed,
    failed: grades.length - passed,
    grades,
  };
}
