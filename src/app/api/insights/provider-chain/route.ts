import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { resolveProviderChain } from "@/lib/ai/provider";
import { getLastWorkingProvider } from "@/lib/ai/provider-runner";

/**
 * v1.4.16 phase B5b — read-only chain summary for the Settings → AI
 * section. Returns:
 *   - `activeProvider`: first entry in the resolved chain (priority
 *     order). Null when the user has no providers configured at all.
 *   - `cachedActiveProvider`: the last working provider from the
 *     in-process cache, when one is set. Surfaces "Active: codex
 *     (cached: openai)" so a user can see the runner has rerouted to
 *     a fallback without digging through logs.
 *   - `configuredChain`: ordered list of `{providerType, available}`
 *     entries. `available` is always true here since the chain
 *     resolver only returns instantiable entries; the field is wired
 *     for the v1.4.17 UX where unconfigured slots should still render
 *     in the list with a "needs setup" pill.
 *
 * The full management UX (drag-to-reorder, enable/disable, add/remove
 * provider entries) is owned by B2 (AI provider settings cleanup) — we
 * intentionally keep this endpoint and the matching panel small so
 * the two phases don't collide.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const chain = await resolveProviderChain(user.id);
  const cached = getLastWorkingProvider(user.id);

  annotate({
    action: { name: "insights.provider_chain.get" },
    meta: {
      chain_length: chain.length,
      chain_active: chain[0]?.providerType ?? null,
      chain_cached_active: cached,
    },
  });

  return apiSuccess({
    activeProvider: chain[0]?.providerType ?? null,
    cachedActiveProvider: cached,
    configuredChain: chain.map((entry) => ({
      providerType: entry.providerType,
      available: true,
    })),
  });
});
