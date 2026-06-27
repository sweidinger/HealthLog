import type { AIProvider, CompletionParams, CompletionResult } from "./types";
import {
  generateInsight,
  type GenerateInsightOutcome,
} from "./generate-insight";
import { InsightSchemaError } from "./schema";
import type { ProviderChainType } from "./provider-chain";
import {
  postgresProviderHealthLedger,
  type ProviderHealthLedger,
  type ProviderSkipHint,
} from "./provider-health-ledger";
import { annotate } from "@/lib/logging/context";

/**
 * The local model is the guaranteed floor (Epic B Pillar 4): a
 * self-hoster running Ollama / LM-Studio must always retain a last
 * resort. These provider types have no remote credential that can
 * expire, so the durable negative cache must never bench them — they
 * stay in the chain even when every keyed provider is in a backoff /
 * auth cooldown.
 */
const NEVER_SKIP: ReadonlySet<ProviderChainType> = new Set(["local"]);

/**
 * v1.4.16 phase B5b — multi-provider redundancy runner.
 *
 * The chain runner wraps `generateInsight()` with a hard-failure
 * walkthrough across an ordered list of providers. The motivation is
 * the maintainer's "ein Provider-Ausfall darf die Insights nicht zerschiessen"
 * mandate: a 401 from Codex (OAuth expired), a 503 from OpenAI
 * (upstream brown-out), or a network reset MUST cascade to the next
 * configured provider rather than 422-ing the whole request.
 *
 * Hard failures (`isHardProviderFailure`) cascade. Schema failures
 * (the existing 422 surface) do NOT cascade — they bubble through
 * `InsightSchemaError` so the user still sees the helpful "the model
 * returned malformed JSON" diagnostic. Walking on schema errors would
 * mask provider-specific prompt-following issues that the v1.4.15
 * citation-enforcement guard exists to surface.
 *
 * Cross-feature coupling:
 *   - B5a's `MEDICAL_REFERENCES` is shared via the system prompt; each
 *     provider in the chain receives the same enriched context.
 *   - B5e (planned v1.4.17) reads `outcome.workingProvider.providerType`
 *     to attribute feedback per provider; that's why we re-export it
 *     out of the runner instead of the wrapper.
 *
 * The cache: a provider that worked on the last call gets first crack
 * on the next, so a user whose Codex OAuth lapsed doesn't re-burn the
 * 401 round-trip on every request for the next hour. Cache is
 * in-process (per worker), keyed by `userId`, TTL 1h. No coordination
 * across workers — when scaling out we'd move this to Redis, but for
 * v1.4.16 the per-worker cache is enough to absorb the typical
 * "polling reload" pattern.
 *
 * v1.18.7 (LOW-8) — DECISION: the volatile per-worker hint is left
 * in-process and NOT folded into the durable Postgres health ledger. The
 * ledger already shares the load-bearing signal across workers (the
 * skip-hint reorder in `resolveChainOrder` pushes a dead-credential /
 * backoff provider to the chain tail for every worker), so the only thing
 * uncoordinated is a soft "tried this one last, put it first" reorder whose
 * worst case is a single redundant first-hop per worker per hour — exactly
 * the bound the v1.18.7 AI audit deemed acceptable at single-maintainer
 * scale. Promoting the hint to a per-request ledger write would add write
 * amplification on the hot path for a negligible saving; revisit only if a
 * multi-worker deploy shows measurable redundant-hop cost.
 */

const LAST_WORKING_TTL_MS = 60 * 60 * 1000; // 1h

interface CacheEntry {
  providerType: ProviderChainType;
  expiresAt: number;
}

const lastWorkingCache = new Map<string, CacheEntry>();

/** Test-only entry-point: empty the in-memory cache between cases. */
export function clearLastWorkingProviderCache(): void {
  lastWorkingCache.clear();
}

/**
 * Fetch the cached "last working provider" for the user, or null if
 * none is cached or the entry has expired. Reads consult `Date.now()`
 * so test code can manipulate `vi.useFakeTimers()` to exercise TTL.
 */
export function getLastWorkingProvider(
  userId: string,
): ProviderChainType | null {
  const entry = lastWorkingCache.get(userId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    lastWorkingCache.delete(userId);
    return null;
  }
  return entry.providerType;
}

function rememberWorkingProvider(
  userId: string,
  providerType: ProviderChainType,
): void {
  lastWorkingCache.set(userId, {
    providerType,
    expiresAt: Date.now() + LAST_WORKING_TTL_MS,
  });
}

/**
 * Classify whether an error from `generateCompletion()` is a "hard
 * provider failure" worth walking past in the fallback chain.
 *
 * Yes:
 *   - 401 / 403 — user's credential is bad for THIS provider; no
 *     amount of retry will help.
 *   - 429 — rate-limited; the next provider may be fresh.
 *   - 5xx — upstream is unhealthy; the next provider may be up.
 *   - Network errors (no `httpStatus`) — DNS, ECONNRESET, timeout.
 *
 * No:
 *   - `InsightSchemaError` — surfaces the wrapper's existing 422 so the
 *     user sees "model JSON malformed" rather than getting silent
 *     provider drift. This is the ONLY non-hard class.
 *
 * v1.21.3 — a 4xx that the PROVIDER WIRE returned (tagged `upstream`,
 * e.g. a Codex `400` rejecting the tool-call / structured request shape)
 * is now hard. It used to fall through `isHardProviderFailure → false`,
 * so the raw error bubbled out of the chain runner UNWRAPPED — the Coach
 * route's catch only handles `AllProvidersFailedError`, so an un-wrapped
 * provider error rethrew as an HTTP 500. Treating every upstream 4xx as
 * hard means it cascades to the next provider and, on exhaustion, is
 * wrapped in `AllProvidersFailedError` so the route surfaces a graceful
 * `coach.provider.*` frame instead of a 500. `InsightSchemaError`
 * (no `upstream` tag) is still excluded, so the strict JSON surface keeps
 * its 422 "model JSON malformed" diagnostic.
 */
export function isHardProviderFailure(error: unknown): boolean {
  if (error instanceof InsightSchemaError) return false;
  const err = error as { httpStatus?: number; name?: string } | null;
  const status = err?.httpStatus;
  if (typeof status !== "number" || status <= 0) {
    // No / sentinel-zero httpStatus → assume network / transport
    // failure (DNS, ECONNRESET, AbortSignal timeout) → hard fail.
    return true;
  }
  if (status === 401 || status === 403 || status === 429) return true;
  if (status >= 500) return true;
  // Any other 4xx surfaced by a provider wire (the Codex / OpenAI /
  // Anthropic clients all tag their thrown errors) is a provider failure,
  // not a caller bug — cascade rather than bubble raw into a 500.
  if (status >= 400) return true;
  return false;
}

export interface ProviderChainResolved {
  /** Logical provider tag (matches `ProviderChainType`). */
  providerType: ProviderChainType;
  /** The constructed provider instance. */
  instance: AIProvider;
}

export interface FallbackHop {
  providerType: ProviderChainType;
  /** 1-indexed; matches the position in the input chain (post-cache reorder). */
  attempt: number;
  failureReason: string;
  httpStatus: number | null;
}

export interface RunWithFallbackParams {
  userId: string;
  providers: ProviderChainResolved[];
  params: CompletionParams;
  /**
   * v1.11.0 W1 — durable provider-health ledger. Defaults to the
   * Postgres-backed implementation in production; unit tests of the pure
   * chain pass an in-memory / no-op ledger to avoid standing up a DB.
   * The ledger is read-through (skip-hint reorder) + write-through
   * (record outcome); it never gates generation — a ledger error always
   * fails open to today's behaviour.
   */
  ledger?: ProviderHealthLedger;
}

export interface RunWithFallbackResult extends GenerateInsightOutcome {
  /** Provider that actually produced the parsed response. */
  workingProvider: ProviderChainResolved;
  /** Hops that failed before the working provider succeeded. */
  fallbackHops: FallbackHop[];
}

/**
 * Hard-fail wrapper around `AllProvidersFailedError.attempts` so the
 * route layer can pick a single representative status (the worst of
 * the bunch) for its 5xx / 503 surface.
 */
export class AllProvidersFailedError extends Error {
  readonly httpStatus: number;
  readonly attempts: FallbackHop[];
  /**
   * v1.11.0 W1 — true when the FIRST (highest-priority) chain entry
   * failed with an auth-class status (401/403). That is the signal a
   * user's primary credential is dead and should be surfaced as
   * `credential_expired` ("reconnect ChatGPT") rather than a generic
   * "try again later". Distinct from "every entry was auth-class" so we
   * only deep-link to reconnect when the user's preferred provider is
   * the thing that broke.
   */
  readonly primaryCredentialExpired: boolean;

  constructor(attempts: FallbackHop[]) {
    super(
      attempts.length === 0
        ? "No AI provider configured"
        : `All ${attempts.length} configured providers failed`,
    );
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
    const first = attempts[0];
    this.primaryCredentialExpired =
      first !== undefined &&
      (first.httpStatus === 401 || first.httpStatus === 403);
    if (attempts.length === 0) {
      this.httpStatus = 422;
      return;
    }
    // Prefer 503 (upstream brown-out) over auth-class — auth-class on
    // every chain entry is more like 422 (user has nothing valid) but
    // we still prefer 503 because it tells the dashboard "try again
    // shortly" rather than "your config is broken" when the truth is
    // the entire stack is degraded. Fall back to the worst observed.
    const has5xx = attempts.some(
      (a) => a.httpStatus !== null && a.httpStatus >= 500,
    );
    if (has5xx) {
      this.httpStatus = 503;
      return;
    }
    const hasAuth = attempts.some(
      (a) => a.httpStatus === 401 || a.httpStatus === 403,
    );
    if (hasAuth) {
      this.httpStatus = 422;
      return;
    }
    this.httpStatus = 503;
  }
}

/**
 * Reorder the input chain so the cached "last working" provider is
 * tried first. Cold cache or unknown provider → original order.
 */
function applyLastWorkingCache(
  userId: string,
  providers: ProviderChainResolved[],
): ProviderChainResolved[] {
  const cached = getLastWorkingProvider(userId);
  if (!cached) return providers;
  const idx = providers.findIndex((p) => p.providerType === cached);
  if (idx <= 0) return providers; // not present, or already first
  const reordered = [...providers];
  const [hit] = reordered.splice(idx, 1);
  reordered.unshift(hit);
  return reordered;
}

/**
 * Apply the durable negative cache. Providers the ledger reports as
 * skippable (dead credential inside its cooldown, or a sustained hard
 * failure in backoff) are moved to the BACK of the chain rather than
 * dropped — so generation is never lost if every healthy provider also
 * fails, but a known-bad credential no longer costs a round-trip on the
 * hot path. The local floor (`NEVER_SKIP`) is always left in place.
 *
 * Order within the "deprioritised" tail is stable, preserving the
 * original chain order so a re-linked credential resumes its priority
 * the moment its cooldown lifts.
 */
function applyHealthLedgerSkips(
  providers: ProviderChainResolved[],
  skips: Map<ProviderChainType, ProviderSkipHint>,
): ProviderChainResolved[] {
  if (skips.size === 0) return providers;
  const preferred: ProviderChainResolved[] = [];
  const deprioritised: ProviderChainResolved[] = [];
  for (const p of providers) {
    const skip = skips.get(p.providerType);
    if (skip && !NEVER_SKIP.has(p.providerType)) {
      deprioritised.push(p);
    } else {
      preferred.push(p);
    }
  }
  return [...preferred, ...deprioritised];
}

/**
 * Compute the order the chain is walked: first the durable health-ledger
 * skips (dead-credential / backoff providers pushed to the tail), then
 * the volatile per-worker last-working reorder on top (a provider that
 * succeeded most recently jumps to the front of whatever survives). The
 * ledger read fails open — on any error the chain is the input order
 * exactly as it walked before the ledger existed.
 */
async function resolveChainOrder(
  userId: string,
  providers: ProviderChainResolved[],
  ledger: ProviderHealthLedger,
): Promise<ProviderChainResolved[]> {
  const skips = await ledger.getSkipHints(userId);
  if (skips.size > 0) {
    annotate({
      meta: {
        ai_chain_skipped_count: skips.size,
        ai_chain_credential_expired: Array.from(skips.values()).some(
          (s) => s.reason === "credential_expired",
        ),
      },
    });
  }
  const afterSkips = applyHealthLedgerSkips(providers, skips);
  return applyLastWorkingCache(userId, afterSkips);
}

function summariseError(e: unknown): {
  reason: string;
  status: number | null;
  bodyExcerpt: string | null;
} {
  const err = e as {
    message?: string;
    httpStatus?: number;
    bodyExcerpt?: string;
  };
  const status = typeof err.httpStatus === "number" ? err.httpStatus : null;
  const message = err.message ?? "unknown error";
  // v1.21.3 — surface the provider's redacted response body (the codex client
  // attaches it) so the wide-event carries the upstream's actual rejection
  // reason, not just "HTTP 400". Already redacted of secrets at the client.
  const bodyExcerpt =
    typeof err.bodyExcerpt === "string" && err.bodyExcerpt.length > 0
      ? err.bodyExcerpt.slice(0, 500)
      : null;
  // Cap to keep wide-event payloads bounded.
  return {
    reason: status !== null ? `HTTP ${status}: ${message}` : message,
    status,
    bodyExcerpt,
  };
}

/**
 * Run an insight generation across an ordered chain of providers,
 * walking past hard provider failures. Schema-class failures (422)
 * bubble unchanged from the underlying wrapper.
 */
export async function runWithFallback(
  args: RunWithFallbackParams,
): Promise<RunWithFallbackResult> {
  const { userId, providers, params } = args;
  const ledger = args.ledger ?? postgresProviderHealthLedger;

  if (providers.length === 0) {
    throw new AllProvidersFailedError([]);
  }

  const ordered = await resolveChainOrder(userId, providers, ledger);
  const hops: FallbackHop[] = [];

  for (let i = 0; i < ordered.length; i += 1) {
    const candidate = ordered[i];
    try {
      const outcome = await generateInsight(candidate.instance, params);
      rememberWorkingProvider(userId, candidate.providerType);
      void ledger.recordSuccess(userId, candidate.providerType);
      annotate({
        meta: {
          ai_chain_working_provider: candidate.providerType,
          ai_chain_fallback_count: hops.length,
        },
      });
      return {
        ...outcome,
        workingProvider: candidate,
        fallbackHops: hops,
      };
    } catch (error) {
      if (!isHardProviderFailure(error)) {
        // Schema/validation error — bubble immediately. NOT recorded in
        // the health ledger: a malformed-JSON reply is a prompt-following
        // issue, not a provider-availability failure.
        throw error;
      }
      const summary = summariseError(error);
      void ledger.recordFailure(userId, candidate.providerType, summary.status);
      const hop: FallbackHop = {
        providerType: candidate.providerType,
        attempt: i + 1,
        failureReason: summary.reason,
        httpStatus: summary.status,
      };
      hops.push(hop);
      annotate({
        meta: {
          [`ai_chain_hop_${i + 1}_provider`]: candidate.providerType,
          [`ai_chain_hop_${i + 1}_status`]: summary.status,
          [`ai_chain_hop_${i + 1}_reason`]: summary.reason.slice(0, 240),
          [`ai_chain_hop_${i + 1}_body`]: summary.bodyExcerpt,
        },
      });
    }
  }

  // Every chain entry hard-failed.
  annotate({
    meta: {
      ai_chain_outcome: "all-failed",
      ai_chain_fallback_count: hops.length,
    },
  });
  throw new AllProvidersFailedError(hops);
}

export interface RunRawWithFallbackResult {
  /** Raw provider response — the legacy `/api/insights/generate` route
   *  consumes the rich shape from `result.content`, so the runner does
   *  not strict-parse it. The `provider-runner` integration test for
   *  v1.4.16 B5b checks that fallback semantics still hold for the
   *  legacy code path. v1.4.17 will migrate this route to the strict
   *  wrapper (B5c work) — at that point this helper is removed. */
  result: CompletionResult;
  workingProvider: ProviderChainResolved;
  fallbackHops: FallbackHop[];
}

/**
 * Sibling of `runWithFallback()` that calls `provider.generateCompletion`
 * directly (no strict-schema wrapper). Used by the legacy route at
 * `/api/insights/generate` which still consumes the rich legacy shape.
 *
 * Fallback policy is identical: hard provider failures cascade,
 * everything else (e.g. a 4xx-but-non-auth from a custom provider)
 * bubbles to the caller. The cache + structured logging are shared
 * with the strict variant.
 */
export async function runRawCompletionWithFallback(args: {
  userId: string;
  providers: ProviderChainResolved[];
  params: CompletionParams;
  /** See `RunWithFallbackParams.ledger`. */
  ledger?: ProviderHealthLedger;
}): Promise<RunRawWithFallbackResult> {
  const { userId, providers, params } = args;
  const ledger = args.ledger ?? postgresProviderHealthLedger;

  if (providers.length === 0) {
    throw new AllProvidersFailedError([]);
  }

  const ordered = await resolveChainOrder(userId, providers, ledger);
  const hops: FallbackHop[] = [];

  for (let i = 0; i < ordered.length; i += 1) {
    const candidate = ordered[i];
    try {
      const result = await candidate.instance.generateCompletion(params);
      rememberWorkingProvider(userId, candidate.providerType);
      void ledger.recordSuccess(userId, candidate.providerType);
      annotate({
        meta: {
          ai_chain_working_provider: candidate.providerType,
          ai_chain_fallback_count: hops.length,
        },
      });
      return {
        result,
        workingProvider: candidate,
        fallbackHops: hops,
      };
    } catch (error) {
      if (!isHardProviderFailure(error)) {
        throw error;
      }
      const summary = summariseError(error);
      void ledger.recordFailure(userId, candidate.providerType, summary.status);
      const hop: FallbackHop = {
        providerType: candidate.providerType,
        attempt: i + 1,
        failureReason: summary.reason,
        httpStatus: summary.status,
      };
      hops.push(hop);
      annotate({
        meta: {
          [`ai_chain_hop_${i + 1}_provider`]: candidate.providerType,
          [`ai_chain_hop_${i + 1}_status`]: summary.status,
          [`ai_chain_hop_${i + 1}_reason`]: summary.reason.slice(0, 240),
          [`ai_chain_hop_${i + 1}_body`]: summary.bodyExcerpt,
        },
      });
    }
  }

  annotate({
    meta: {
      ai_chain_outcome: "all-failed",
      ai_chain_fallback_count: hops.length,
    },
  });
  throw new AllProvidersFailedError(hops);
}
