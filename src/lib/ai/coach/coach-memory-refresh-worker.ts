/**
 * v1.11.1 — worker pipeline for the combined Coach memory-refresh queue.
 *
 * Runs both background generators for one conversation, sequentially so they
 * share the wake-up but each pays its own budget check inside
 * `runStatusCompletion`: the rolling conversation summary first, then durable
 * fact extraction. Each step is fault-isolated — a failure or no-provider in
 * one never sinks the other or the job. Kept out of the route bundle (the
 * route imports only `enqueueCoachMemoryRefresh` from `coach-memory-shared`).
 */
import { annotate } from "@/lib/logging/context";

import type { CoachMemoryRefreshPayload } from "./coach-memory-shared";
import { extractAndStoreFacts } from "./facts";
import { extractAndStorePlanProposals } from "./plans";
import { refreshConversationSummary } from "./conversation-summary";

export async function runCoachMemoryRefresh(
  payload: CoachMemoryRefreshPayload,
): Promise<void> {
  const { conversationId, userId } = payload;
  const locale = payload.locale ?? "de";

  let summaryStatus = "error";
  try {
    const result = await refreshConversationSummary(conversationId, userId, {
      locale,
    });
    summaryStatus = result.status;
  } catch (err) {
    annotate({
      action: { name: "coach.memory.refresh.summary_failed" },
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  let factsStatus = "error";
  let factsCount = 0;
  try {
    const result = await extractAndStoreFacts(conversationId, userId, {
      locale,
    });
    factsStatus = result.status;
    factsCount = result.count;
  } catch (err) {
    annotate({
      action: { name: "coach.memory.refresh.facts_failed" },
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // v1.21.3 (B1) — durable goal / if-then plan proposals. Same worker pass
  // (no separate pg-boss queue), fault-isolated like the facts step: a failure
  // or no-provider here never sinks the summary / facts work or the job. Plans
  // are written as `proposed`; the user confirms them through the PATCH route.
  let plansStatus = "error";
  let plansCount = 0;
  try {
    const result = await extractAndStorePlanProposals(conversationId, userId, {
      locale,
    });
    plansStatus = result.status;
    plansCount = result.count;
  } catch (err) {
    annotate({
      action: { name: "coach.memory.refresh.plans_failed" },
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  annotate({
    action: { name: "coach.memory.refresh.done" },
    meta: { summaryStatus, factsStatus, factsCount, plansStatus, plansCount },
  });
}
