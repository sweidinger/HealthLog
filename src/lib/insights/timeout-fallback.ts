import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

/**
 * Shared timeout / provider-error fallback for the InsightStatus routes.
 *
 * When the upstream provider call exceeds `STATUS_PROVIDER_TIMEOUT_MS`
 * (or rejects outright) the generator still has to return a deterministic
 * envelope. It used to persist a sentinel row carrying the generic
 * fallback under the same `text` field a real assessment uses; the
 * cache-read served it as valid and it stuck until midnight — hiding the
 * real, data-driven assessment for the rest of the day on any account that
 * hit a single transient stall. v1.4.28 removed that persist entirely.
 *
 * v1.8.3 — re-introduce a *negative* cache, but a strictly bounded one. The
 * status route is now read-only: a cache miss enqueues an out-of-band
 * generation. If the provider stalls inside the worker, nothing stops the
 * next navigation from enqueuing again, and again — a stalled provider
 * turns into a re-enqueue storm. So the timeout path writes a short-TTL
 * negative stub (`{ timeout:true, model:"timeout-stub", retryAt }`). The
 * read-only resolver honours it: while the stub is fresh it returns
 * `preparing` WITHOUT re-enqueuing; once `retryAt` passes the stub is stale
 * and the next visit re-attempts. The stub is NEVER served as assessment
 * text — `readFreshStatusText` still rejects every timeout stub by marker,
 * so a transient stall can't hide the real assessment for the day.
 */

/** Short retry window after a provider stall before a re-enqueue is allowed. */
export const TIMEOUT_NEGATIVE_CACHE_MS = 5 * 60 * 1000;

/**
 * Persist a short-TTL negative-cache stub for `(userId, cacheAction)`.
 * Best-effort: a failure here just means the read-only resolver may
 * re-enqueue sooner than the window intended.
 */
export async function persistTimeoutNegativeStub(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  reason: "timeout" | "error";
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: args.userId,
        action: args.cacheAction,
        details: JSON.stringify({
          dateKey: args.todayKey,
          timeout: true,
          model: "timeout-stub",
          reason: args.reason,
          retryAt: new Date(
            Date.now() + TIMEOUT_NEGATIVE_CACHE_MS,
          ).toISOString(),
        }),
      },
    });
  } catch {
    // Negative cache is best-effort — never throw out of the timeout path.
  }
}

/**
 * Return the deterministic fallback envelope for a timeout / error. The
 * current render still gets the fallback text, marked `cached:true` so the
 * UI does not mislabel it as a fresh assessment and `updatedAt:null` to
 * signal "no persisted assessment". When `userId` + `todayKey` are present
 * (the worker-side generation path) a short-TTL negative stub is persisted
 * so a stalled provider doesn't trigger a re-enqueue storm.
 *
 * v1.21.0 (coach C1 HIGH-1) — the envelope now reports `hasProvider:false`.
 * The `stubText` is a DETERMINISTIC (signal-grounded or generic) line, not a
 * fresh provider assessment; reporting `hasProvider:true` let the UI render
 * it in the primary assessment slot indistinguishable from real AI prose on
 * any slow/errored call. `false` lets the UI surface it honestly as the
 * computed/offline summary it is. This is independent of whether the user
 * has a provider configured at all — it describes THIS text's authorship.
 */
export function returnTimeoutFallback(input: {
  cacheAction: string;
  reason: "timeout" | "error";
  stubText: string;
  userId?: string;
  todayKey?: string;
}): {
  hasProvider: false;
  text: string;
  cached: true;
  updatedAt: null;
} {
  annotate({
    action: { name: "insights.status.fallback_served" },
    meta: { cacheAction: input.cacheAction, reason: input.reason },
  });
  if (input.userId && input.todayKey) {
    // Fire-and-forget — the caller's render must not wait on the write.
    void persistTimeoutNegativeStub({
      userId: input.userId,
      cacheAction: input.cacheAction,
      todayKey: input.todayKey,
      reason: input.reason,
    });
  }
  return {
    hasProvider: false,
    text: input.stubText,
    cached: true,
    updatedAt: null,
  };
}
