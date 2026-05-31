import { annotate } from "@/lib/logging/context";

/**
 * Shared timeout / provider-error fallback for the InsightStatus routes.
 *
 * When the upstream provider call exceeds `STATUS_PROVIDER_TIMEOUT_MS`
 * (or rejects outright) the route still has to return a deterministic
 * envelope so the InsightStatusCard renders the no-key fallback text
 * instead of spinning. It used to ALSO persist a sentinel `auditLog`
 * row keyed to today's Berlin day. That stub carried the generic
 * fallback under the same `text` field a real assessment uses, the
 * cache-read served it as valid, and it stuck until midnight — hiding
 * the real, data-driven assessment for the rest of the day on any
 * account that hit a single transient stall.
 *
 * The fix removes the persist entirely: a timeout / error is treated as
 * a transient miss. The current render still gets the fallback text, but
 * nothing is written, so the next mount re-attempts a real generation.
 * The shared cache-read (`status-cache.ts`) additionally rejects any
 * legacy stub rows still in the table by their `model:"timeout-stub"` /
 * `timeout:true` markers.
 *
 * `cached:true` is kept so the UI does not mislabel the fallback as a
 * fresh assessment, and `updatedAt:null` signals "no persisted row".
 */
export function returnTimeoutFallback(input: {
  cacheAction: string;
  reason: "timeout" | "error";
  stubText: string;
}): {
  hasProvider: true;
  text: string;
  cached: true;
  updatedAt: null;
} {
  annotate({
    action: { name: "insights.status.fallback_served" },
    meta: { cacheAction: input.cacheAction, reason: input.reason },
  });
  return {
    hasProvider: true,
    text: input.stubText,
    cached: true,
    updatedAt: null,
  };
}
