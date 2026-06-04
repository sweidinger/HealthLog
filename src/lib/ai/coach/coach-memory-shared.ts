/**
 * v1.11.1 — generator-free contract for the Coach long-term-memory refresh
 * queue. The chat route enqueues a single-conversation refresh here without
 * importing the concrete generators (which would pull the provider chain into
 * the route bundle). The worker handler (`runCoachMemoryRefresh`) calls the
 * summary + fact generators; it re-uses the queue name from here so there is
 * one source of truth.
 *
 * One combined queue does BOTH conversation-summary refresh and durable-fact
 * extraction in a single worker job: when a long conversation crosses the
 * history-window cap, both are usually due together, so one job + one
 * singleton window avoids a second queue and a redundant wake-up.
 *
 * Mirrors `period-narrative-shared.ts`: queue name + payload type + enqueue
 * helper here, the concrete dispatch in the worker.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";

export const COACH_MEMORY_REFRESH_QUEUE = "coach-memory-refresh";

export interface CoachMemoryRefreshPayload {
  conversationId: string;
  userId: string;
  /** Locale to compose the summary / facts prose in; defaults to "de". */
  locale?: "de" | "en";
}

/**
 * Fire-and-forget enqueue from the chat turn once a conversation has grown past
 * the history-window cap. A `singletonKey` per conversation collapses repeated
 * turns within a short window into one queued job. No-ops cleanly when the
 * global boss is unavailable (a web process without an embedded worker) — the
 * memory simply stays as-is until the next eligible turn.
 */
export async function enqueueCoachMemoryRefresh(payload: {
  conversationId: string;
  userId: string;
  locale: "de" | "en";
}): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) return;
  try {
    await boss.send(
      COACH_MEMORY_REFRESH_QUEUE,
      {
        conversationId: payload.conversationId,
        userId: payload.userId,
        locale: payload.locale,
      } satisfies CoachMemoryRefreshPayload,
      {
        singletonKey: `refresh:${payload.conversationId}`,
        singletonSeconds: 120,
      },
    );
    annotate({
      action: { name: "coach.memory.refresh.enqueued" },
      meta: { locale: payload.locale },
    });
  } catch {
    // Best-effort — a failure just leaves the Coach memory unchanged until the
    // next eligible turn re-enqueues.
  }
}
