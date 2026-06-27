/**
 * Coach evaluation case driver (B0, v1.21.3).
 *
 * The single seam both the deterministic graders and the opt-in live judge
 * consume: a case in, a {prose, toolPayloads} capture out. There are two ways
 * to produce that capture:
 *
 *   1. DETERMINISTIC (the per-PR / nightly free floor): the prose is the case's
 *      `idealResponse`, and the authoritative payload set is whatever the case
 *      delivered to the model this turn — its scripted tool results on the tool
 *      path, or the snapshot sections on the no-tools path. No model call, no
 *      network, no flakiness. This proves the GRADERS are correct and the ideal
 *      responses clear them.
 *
 *   2. LIVE (layer 2, gated on `COACH_EVAL_API_KEY`): the prose is the REAL
 *      generation. `runRealCase` drives the actual `runCoachToolLoop` with a
 *      resolved provider chain and captures `result.content` + the loop's
 *      `toolResults` payloads. Used only by `judge.ts`, only when the secret is
 *      present.
 *
 * The authoritative payload-set rule is identical on both paths, so the
 * grounding grader grades the same way whether the prose is scripted or real:
 *   - tool path  → the present tool-result `data` payloads,
 *   - no-tools   → the single `snapshotSections` record.
 * This mirrors the route exactly (`coach-prose-grounding-no-tools.test.ts`).
 */
import type { CoachEvalCase } from "./golden-cases";

/** The capture both grader layers consume. */
export interface CoachCaseCapture {
  /** The case id, for reporting. */
  id: string;
  /** The prose under grading (scripted ideal, or real generation). */
  prose: string;
  /**
   * The authoritative payload set the prose is graded against — the tool-result
   * `data` payloads on the tool path, or the single snapshot record on the
   * no-tools path. Matches the route's verifier-payload rule exactly.
   */
  toolPayloads: ReadonlyArray<unknown>;
}

/**
 * Resolve the authoritative payload set for a case the same way the route does:
 * the present tool-result payloads when the case scripts tools, else the
 * snapshot sections as the single no-tools payload.
 */
export function authoritativePayloads(
  testCase: CoachEvalCase,
): ReadonlyArray<unknown> {
  if (testCase.scriptedToolResults && testCase.scriptedToolResults.length > 0) {
    return testCase.scriptedToolResults
      .filter((r) => r.present)
      .map((r) => r.data);
  }
  return [testCase.snapshotSections];
}

/**
 * DETERMINISTIC capture: grade the case's reference prose against the case's own
 * authoritative payload set. No model, no network.
 */
export function captureDeterministic(
  testCase: CoachEvalCase,
): CoachCaseCapture {
  return {
    id: testCase.id,
    prose: testCase.idealResponse,
    toolPayloads: authoritativePayloads(testCase),
  };
}

/**
 * LIVE capture: drive the real bounded retrieval loop with a resolved provider
 * chain and capture the generated prose + the loop's present tool payloads.
 *
 * Only `judge.ts` calls this, and only when `COACH_EVAL_API_KEY` is present. It
 * is the ONLY path in the harness that touches the network. Kept dependency-lazy
 * (dynamic import of the loop) so importing this module for the deterministic
 * path never drags the provider graph in.
 */
export async function runRealCase(args: {
  testCase: CoachEvalCase;
  /** A resolved provider chain (the judge builds this from the eval key). */
  providers: import("@/lib/ai/provider-runner").ProviderChainResolved[];
  system: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<CoachCaseCapture> {
  const { runCoachToolLoop } = await import("@/lib/ai/coach/tools/loop");
  const { testCase, providers, system, temperature, maxTokens } = args;

  const out = await runCoachToolLoop({
    userId: `eval:${testCase.id}`,
    providers,
    system,
    messages: [{ role: "user", content: testCase.userMessage }],
    // The eval drives generation; tools are offered but the case's snapshot is
    // folded into the system prompt by the judge so a no-tools provider still
    // has the context. The loop tolerates an empty toolCalls (no-tools path).
    tools: [],
    temperature,
    maxTokens,
  });

  const toolPayloads =
    out.toolResults.length > 0
      ? out.toolResults.filter((r) => r.present).map((r) => r.data)
      : [testCase.snapshotSections];

  return { id: testCase.id, prose: out.result.content ?? "", toolPayloads };
}
