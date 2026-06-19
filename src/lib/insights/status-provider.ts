import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
  type ProviderChainResolved,
} from "@/lib/ai/provider-runner";
import {
  chainRequiresServerManagedConsent,
  hasActiveConsentForSurface,
  type ConsentSurface,
} from "@/lib/ai/consent-guard";
import { annotate } from "@/lib/logging/context";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { STATUS_PROVIDER_TIMEOUT_MS, withTimeout } from "./with-timeout";

/**
 * Shared provider plumbing for the seven `*-status.ts` generators.
 *
 * Before this, each generator resolved a single provider via
 * `resolveProvider()` and raced one `generateCompletion()` call against
 * a 20 s cap. A degraded primary provider could not cascade, and the
 * cap fired below the providers' own 60 s floor — converting healthy-
 * but-slow generations into the generic fallback.
 *
 * This helper mirrors the Coach (`chat/route.ts`): resolve the user's
 * provider chain, fall back to the legacy single provider when the chain
 * is empty, and run `runRawCompletionWithFallback` so a degraded provider
 * cascades to the next. The whole thing is still wrapped in
 * `withTimeout` at the aligned 60 s budget so a total stall can't pin the
 * card — but a timeout / error is reported as a transient miss (the
 * caller serves the fallback for this render without persisting it),
 * never as the day's cached assessment.
 */

export type StatusProviderResult =
  | { kind: "none" }
  | { kind: "timeout" }
  | { kind: "error" }
  | {
      kind: "ok";
      content: string;
      providerType: string;
      model: string;
      tokensUsed: number | null;
    };

interface RunStatusCompletionArgs {
  userId: string;
  cacheAction: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * v1.12.1 — which AI surface this generation serves, for the consent gate.
   * `insights` for the per-metric status cards + period narrative; `coach`
   * for the off-budget Coach memory workers (rolling summary + fact
   * extraction). When the resolved chain would egress via the operator's
   * server-managed key and no active receipt of the matching kind exists,
   * the run short-circuits to `{ kind: "none" }` (the no-key fallback) so no
   * PHI leaves the server. BYOK / local / ChatGPT-OAuth chains are ungated.
   */
  consentSurface: ConsentSurface;
}

/**
 * Resolve the provider chain for `userId`, falling back to the legacy
 * single provider. Returns `null` when the user has no usable provider
 * anywhere (the caller surfaces the no-key fallback with
 * `hasProvider:false`).
 */
async function resolveStatusChain(
  userId: string,
): Promise<ProviderChainResolved[] | null> {
  const chain = await resolveProviderChain(userId);
  if (chain.length > 0) return chain;

  const legacy = await resolveProvider(userId);
  if (legacy.type === "none") return null;
  return [{ providerType: "admin-openai", instance: legacy }];
}

/**
 * Cheap provider-availability probe for the read-only status path.
 *
 * v1.8.3 — when a status route runs in read-only mode (serve cache, never
 * block on the LLM) it still has to tell the difference between "no
 * provider — show the no-key fallback" and "provider configured but the
 * assessment isn't warm yet — show preparing + enqueue a generation". This
 * resolves the same chain `runStatusCompletion` would, but does NOT run a
 * completion, so the navigation request never awaits an LLM round-trip.
 */
export async function hasUsableStatusProvider(
  userId: string,
): Promise<boolean> {
  return (await resolveStatusChain(userId)) !== null;
}

/**
 * v1.16.8 — true when a status generation for `userId` would be blocked
 * by the server-managed consent gate (the same check `runStatusCompletion`
 * applies before egress). The content-hash gate
 * (`refreshUnchangedStatusInsight`) consults this BEFORE re-stamping a
 * cached assessment as current: after a consent revocation the unchanged-
 * data refresh must fall through to the generator, whose own gate then
 * serves the no-key fallback instead of presenting old AI text as fresh.
 * `false` when no provider is configured at all — that path already
 * resolves to the fallback via `{ kind: "none" }`.
 */
export async function statusConsentBlocksGeneration(
  userId: string,
  surface: ConsentSurface,
): Promise<boolean> {
  const chain = await resolveStatusChain(userId);
  if (chain === null) return false;
  return (
    chainRequiresServerManagedConsent(chain) &&
    !(await hasActiveConsentForSurface(userId, surface))
  );
}

/**
 * Run a status generation across the user's provider chain, bounded by
 * `STATUS_PROVIDER_TIMEOUT_MS`. The result discriminates between
 * no-provider / timeout / provider-error / success so the caller can
 * decide what to persist — only `ok` is ever cached as the day's
 * assessment.
 */
export async function runStatusCompletion(
  args: RunStatusCompletionArgs,
): Promise<StatusProviderResult> {
  const { userId, cacheAction, systemPrompt, userPrompt } = args;

  const chain = await resolveStatusChain(userId);
  if (chain === null) {
    return { kind: "none" };
  }

  // v1.12.1 — consent gate before server-managed external egress. A chain
  // that could egress via the operator's global key requires an active
  // receipt of the surface's mapped kind (or master `ai_full`). Without one,
  // surface the no-key fallback (`none`) rather than egress the snapshot —
  // identical to a missing provider from the caller's perspective, so no
  // generator branch needs to change. BYOK / local / ChatGPT-OAuth chains
  // never trip this.
  if (
    chainRequiresServerManagedConsent(chain) &&
    !(await hasActiveConsentForSurface(userId, args.consentSurface))
  ) {
    annotate({
      action: { name: "insights.status.consent_required" },
      meta: { cacheAction, surface: args.consentSurface },
    });
    return { kind: "none" };
  }

  const raced = await withTimeout(
    () =>
      runRawCompletionWithFallback({
        userId,
        providers: chain,
        params: {
          systemPrompt,
          userPrompt,
          temperature: args.temperature ?? AI_BUDGETS.status.temperature,
          maxTokens: args.maxTokens ?? AI_BUDGETS.status.maxTokens,
        },
      }),
    STATUS_PROVIDER_TIMEOUT_MS,
    null,
  );

  if (raced.timedOut) {
    return { kind: "timeout" };
  }
  if (raced.errored || raced.value === null) {
    return { kind: "error" };
  }

  const { result, workingProvider } = raced.value;
  const content = result.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    annotate({
      action: { name: "insights.status.empty_content" },
      meta: { cacheAction, providerType: workingProvider.providerType },
    });
    return { kind: "error" };
  }

  return {
    kind: "ok",
    content,
    providerType: workingProvider.providerType,
    model: result.model ?? "unknown",
    tokensUsed: result.tokensUsed ?? null,
  };
}

export { AllProvidersFailedError };
