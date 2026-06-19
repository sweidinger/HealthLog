"use client";

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InsightResult } from "@/lib/ai/types";
// Type-only — the runtime schemas load lazily inside `fetchAdvisor` so
// the zod module graph (`@/lib/ai/schema` is ~550 lines of zod builders)
// stays out of the insights route-entry chunk. This hook is imported
// eagerly by BOTH the insights page and the layout shell, so a value
// import here landed zod in the chunk every insights visit downloads
// before first paint; the schemas are only needed once a payload has
// actually arrived, which is by definition after the network hop.
import type {
  DailyBriefing as DailyBriefingPayload,
  TrendAnnotations,
} from "@/lib/ai/schema";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw } from "@/lib/api/api-fetch";

/**
 * v1.4.16 phase D reconcile (CRITICAL C1 + C2) — shared TanStack Query
 * helper that reads the rich advisor payload from `/api/insights/generate`.
 *
 * Why a POST under a `useQuery` rather than a dedicated GET endpoint:
 * the route already cache-returns the most recent generation (24h TTL on
 * `User.insightsCachedAt` / `User.insightsCachedText`) without burning a
 * rate-limit token, so a single POST-without-`force` is functionally a
 * GET-or-generate. Adding a separate GET would duplicate the cache-read
 * branch and split the audit-log surface; the reconcile report deferred
 * C1+C2 specifically because it assumed that duplication was required,
 * but the route already supports the cache-aware path.
 *
 * Every surface that mounts the query under the same key shares the
 * cache, so a regenerate from one surface refreshes the others without
 * a second LLM call.
 */
export interface InsightAdvisorPayload {
  insights: InsightResult;
  cached: boolean;
  cachedAt?: string | null;
  legacyPayload?: boolean;
  /**
   * v1.4.20 phase B1 — Daily Briefing block surfaced for the new hero
   * strip + briefing card. Lives on the cached payload alongside the
   * legacy `insights` shape (see `aiInsightResponseSchema` — the
   * `.passthrough()` lets the field round-trip through any provider).
   * Validated client-side via the schema's `safeParse` to keep a
   * malformed payload from poisoning the briefing card.
   */
  dailyBriefing?: DailyBriefingPayload | null;
  /**
   * v1.4.20 phase B3 — optional trend annotations for the Trends row.
   * Same lift-pattern as `dailyBriefing` — validated client-side and
   * left null when the cached payload predates PROMPT_VERSION 4.20.1.
   */
  trendAnnotations?: TrendAnnotations | null;
  /**
   * v1.16.7 — true when the GET served a stale / missing briefing AND
   * enqueued an out-of-band warm. The query polls (bounded) while this
   * is set so the fresh briefing reaches the open page in-session
   * instead of waiting for the next mount.
   */
  revalidating?: boolean;
}

/**
 * v1.4.31 — bound the advisor READ (GET) with an 8-second
 * `AbortController` so a cache-miss path (server still warming out of
 * band) does not pin the mother-page main thread. The strip stays
 * interactive in the DOM; dropping the worst case from 30 s to 8 s
 * eliminates the mobile-tap-block window per
 * `.planning/research/v15-insights-blocking-bug.md` fix 1.
 */
const ADVISOR_TIMEOUT_MS = 8_000;

/**
 * v1.15.18 — the user-initiated regenerate (`force`) POSTs an INLINE
 * generation: a ~1500-token warm completion that routinely runs longer
 * than the 8 s read budget. Bounding the force branch at 8 s silently
 * discarded a slow-but-successful generation — the abort returned a null
 * payload, the mutation only invalidated (re-reading the OLD cache), yet
 * the server had often already written the fresh briefing. Give the force
 * branch the same 45 s budget the out-of-band warm job uses
 * (`COMPREHENSIVE_WARM_TIMEOUT_MS`) so a slow success is kept, not
 * dropped. The READ path stays fast at 8 s — only the explicit user tap
 * may wait. Per `.planning/v1.15.18-daily-briefing-audit.md` Fix 1b.
 */
const FORCE_ADVISOR_TIMEOUT_MS = 45_000;

/**
 * v1.16.7 — poll cadence + ceiling while the server reports
 * `revalidating: true` (stale briefing served, out-of-band warm in
 * flight). The query's 1 h `staleTime` plus the app-default
 * `refetchOnWindowFocus: false` means a stale-served briefing would
 * otherwise never refresh in-session. 25 s comfortably covers the warm
 * job's 45 s budget within two polls; the attempt ceiling stops a
 * persistently failing generation from polling an open page forever.
 * Same bounded-poll shape as `nextStatusPollInterval`
 * (`src/hooks/use-insight-status.ts`).
 */
export const ADVISOR_REVALIDATE_POLL_MS = 25_000;
export const ADVISOR_REVALIDATE_POLL_MAX_ATTEMPTS = 10;

/**
 * Decide whether the advisor query schedules its next poll. Pure so the
 * ceiling + stop conditions are unit-testable: returns the interval
 * while the last payload carries `revalidating: true`, `false` once a
 * response comes back with the flag falsy OR the attempt cap is hit.
 */
export function nextAdvisorPollInterval(
  revalidating: boolean | undefined,
  dataUpdateCount: number,
): number | false {
  if (!revalidating) return false;
  if (dataUpdateCount >= ADVISOR_REVALIDATE_POLL_MAX_ATTEMPTS) return false;
  return ADVISOR_REVALIDATE_POLL_MS;
}

/**
 * v1.15.18 — the outcome of a force regenerate, so the UI can be HONEST:
 * only a `fresh` outcome should toast "refreshed". A `timeout` (slow gen
 * the client gave up on) and a `no-provider` (422) are distinct failure
 * modes.
 *
 * v1.15.20 — `rate-limited` (429) splits off from `empty`: the user's
 * regenerate quota is exhausted, which deserves a "try again later"
 * hint rather than the success toast the old lump produced. `empty` now
 * means only the transient 503 surface (provider chain unavailable).
 */
export type AdvisorFetchOutcome =
  | "fresh"
  | "empty"
  | "rate-limited"
  | "timeout"
  | "no-provider";

interface AdvisorFetchResult {
  payload: InsightAdvisorPayload | null;
  outcome: AdvisorFetchOutcome;
}

async function fetchAdvisor(
  options: { force?: boolean } = {},
): Promise<AdvisorFetchResult> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    options.force ? FORCE_ADVISOR_TIMEOUT_MS : ADVISOR_TIMEOUT_MS,
  );
  let res: Response;
  try {
    // Read path (no `force`): the GET serves the cached briefing read-only
    // and enqueues an out-of-band warm on a stale / missing cache — it
    // never blocks the page-load path on the provider chain. Only the
    // user-initiated regenerate (`force`) POSTs to generate inline.
    // apiFetchRaw: this path branches on raw status codes (422 / 429 /
    // 503 are expected, non-throwing surfaces) — the unwrap helpers
    // would turn them into thrown ApiErrors.
    res = options.force
      ? await apiFetchRaw("/api/insights/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
          signal: controller.signal,
        })
      : await apiFetchRaw("/api/insights/generate", {
          method: "GET",
          signal: controller.signal,
        });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // Graceful empty payload — the UI surfaces the empty / regen
      // CTA exactly as it does for the 422 / 429 / 503 paths below.
      // `timeout` lets the regenerate path avoid claiming success.
      return { payload: null, outcome: "timeout" };
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (!res.ok) {
    // 422 (no provider configured), 429 (rate-limited), and 503
    // (provider chain unavailable) are expected surfaces — return null
    // so the consuming UI shows the empty / error state without the
    // query slipping into an `isError` retry loop. Each gets its own
    // outcome tag so the regenerate toast can be honest about WHY no
    // fresh payload arrived.
    if (res.status === 422) {
      return { payload: null, outcome: "no-provider" };
    }
    if (res.status === 429) {
      return { payload: null, outcome: "rate-limited" };
    }
    if (res.status === 503) {
      return { payload: null, outcome: "empty" };
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  const payload = json.data as InsightAdvisorPayload;
  // Lazy schema load — see the type-only import note at the top. The
  // module is cached after the first call, so this await is free from
  // the second fetch on.
  const { dailyBriefingSchema, trendAnnotationsSchema } =
    await import("@/lib/ai/schema");
  // The cached `insights` blob may carry a `dailyBriefing` from a fresh
  // PROMPT_VERSION 4.20.x generation. Lift it onto the payload so
  // consumers don't have to know the legacy shape.
  const briefingCandidate = (payload?.insights as Record<string, unknown>)
    ?.dailyBriefing;
  if (briefingCandidate != null) {
    const parsed = dailyBriefingSchema.safeParse(briefingCandidate);
    if (parsed.success) {
      payload.dailyBriefing = parsed.data;
    } else {
      // Malformed cached briefing — keep null so the UI shows the
      // empty-state CTA instead of a half-rendered card.
      payload.dailyBriefing = null;
    }
  } else {
    payload.dailyBriefing = null;
  }

  // v1.4.20 phase B3 — same lift for `trendAnnotations`. Cached payloads
  // from the 4.20.0 line predate the field, so null is the expected
  // default. A malformed candidate also resolves to null so the UI
  // surfaces the per-metric empty hint instead of a half-rendered card.
  const annotationsCandidate = (payload?.insights as Record<string, unknown>)
    ?.trendAnnotations;
  if (annotationsCandidate != null) {
    const parsed = trendAnnotationsSchema.safeParse(annotationsCandidate);
    payload.trendAnnotations = parsed.success ? parsed.data : null;
  } else {
    payload.trendAnnotations = null;
  }
  return { payload, outcome: "fresh" };
}

export interface UseInsightsAdvisorResult {
  payload: InsightAdvisorPayload | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  regenerate: () => void;
  isRegenerating: boolean;
  regenerateError: Error | null;
  /**
   * v1.15.18 — the outcome of the LAST settled regenerate. The tab strip
   * fires the "refreshed" toast only when this is `"fresh"`, so a slow gen
   * the client gave up on (`"timeout"`) or a missing provider
   * (`"no-provider"`) never reads as "done".
   */
  regenerateOutcome: AdvisorFetchOutcome | null;
  /**
   * v1.15.20 — the outcome of the last settled READ. Lets surfaces
   * distinguish "no briefing yet, a generate could help" (`empty` /
   * `timeout`) from "no provider configured, generating is futile"
   * (`no-provider`) and render a connect-AI hint instead of a dead
   * regenerate CTA.
   */
  readOutcome: AdvisorFetchOutcome | null;
}

/**
 * Read-only consumer for the advisor payload. Use this on surfaces that
 * just want to render the cached insight (e.g. dashboard preview).
 */
export function useInsightsAdvisorQuery(
  enabled: boolean,
): UseInsightsAdvisorResult {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.insightsAdvisor(),
    // v1.15.20 — the cache stores the full tagged result (payload +
    // outcome) so the read path can surface WHY a payload is missing
    // (`no-provider` → connect-AI hint instead of a dead regenerate CTA).
    queryFn: () => fetchAdvisor(),
    enabled,
    // 24h cache window matches the server-side `insightsCachedAt` TTL.
    staleTime: 60 * 60 * 1000,
    retry: false,
    // v1.16.7 — converge a stale-served briefing in-session: while the
    // last GET reported `revalidating: true` (warm enqueued), poll on a
    // bounded interval until a response comes back with the flag falsy.
    refetchInterval: (query) =>
      nextAdvisorPollInterval(
        query.state.data?.payload?.revalidating,
        query.state.dataUpdateCount,
      ),
  });

  const mutation = useMutation({
    mutationFn: () => fetchAdvisor({ force: true }),
    onSuccess: (result) => {
      if (result.payload) {
        // A genuinely fresh generation landed — write it into the shared
        // cache so the hero subtitle + briefing card repaint immediately.
        queryClient.setQueryData(queryKeys.insightsAdvisor(), result);
      } else {
        // No fresh payload (timeout / no-provider / transient). The server's
        // inline POST may STILL have written a fresh briefing after the
        // client gave up at 45 s, so re-read the GET to converge — but the
        // honest toast is gated on `regenerateOutcome` below, not on this
        // invalidate.
        queryClient.invalidateQueries({
          queryKey: queryKeys.insightsAdvisor(),
        });
      }
      // Per-status caches are evicted server-side on regenerate; refresh
      // their query subtree so the per-section text below the advisor card
      // re-fetches.
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
    },
  });

  // v1.8.3 — stabilise the `regenerate` callback so the memoised
  // `<InsightsTabStrip>` (which receives it as `onRegenerate`) is not
  // re-rendered on every shell render by a fresh arrow reference. A
  // status-query flip on a sub-page that re-renders the shell would
  // otherwise re-reconcile the whole strip mid-gesture and eat taps.
  const { mutate } = mutation;
  const regenerate = useCallback(() => mutate(), [mutate]);

  return {
    payload: query.data?.payload ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error | null) ?? null,
    regenerate,
    isRegenerating: mutation.isPending,
    regenerateError: (mutation.error as Error | null) ?? null,
    regenerateOutcome: mutation.data?.outcome ?? null,
    readOutcome: query.data?.outcome ?? null,
  };
}
