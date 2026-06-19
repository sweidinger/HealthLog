/**
 * v1.11.0 W1 — durable provider-health ledger.
 *
 * Epic B Pillar 4 (resilience floor). Promotes the volatile per-worker
 * `lastWorkingCache` in `provider-runner.ts` to a Postgres table so the
 * fallback chain shares one health signal across every worker, exactly
 * like the rate limiter ("rate limits live in Postgres"). The ledger is
 * a read-through reporter layered AROUND the existing
 * `isHardProviderFailure` classifier — it never re-decides what a
 * failure is; it only remembers the outcome.
 *
 * Two jobs:
 *   1. **Negative cache** for an auth-class failure (401/403 =
 *      "credential dead, re-link required"). Instead of re-burning the
 *      dead round-trip on every generation, the runner skips a provider
 *      whose row reads `auth_failed` while `nextRetryAt` is in the
 *      future. The cooldown is far longer than the old 1h in-memory TTL
 *      so a single expired codex token does not silently kill every
 *      generation for the next hour-per-worker.
 *   2. **Proactive surfacing.** `findCredentialExpiredProviders` lets
 *      the coach route / a health check report a known-bad credential
 *      ("ChatGPT connection expired — reconnect") rather than leaving
 *      the failure invisible until the next manual Coach turn.
 *
 * Resilience: every DB interaction is best-effort. The ledger is an
 * optimisation, never a gate — a transient DB error must never take
 * down generation, so reads fail open (empty result) and writes are
 * fire-and-forget. This keeps the runner's existing behaviour the
 * floor: worst case, the ledger contributes nothing and the chain walks
 * exactly as it does today.
 */

import { prisma } from "@/lib/db";
import type { ProviderChainType } from "./provider-chain";

/** Auth-class negative-cache cooldown — a dead credential is skipped
 *  for this long before the chain re-probes it. Long enough that a
 *  lapsed codex/OpenAI key is not re-tried every generation, short
 *  enough that a re-linked credential recovers within a day without an
 *  explicit clear. A successful generation clears it immediately. */
export const AUTH_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

/** Backoff for non-auth hard failures (429 / 5xx / network). Short —
 *  these are usually transient brown-outs, so we only briefly
 *  deprioritise rather than skip. */
export const HARD_FAILURE_COOLDOWN_MS = 5 * 60 * 1000; // 5min

/** A provider stays in the skip set only while its consecutive-failure
 *  count is at or above this floor — a single transient hard failure
 *  does not bench a provider; a sustained one does. Auth failures skip
 *  immediately (count irrelevant) because retrying a dead credential is
 *  never productive. */
export const HARD_FAILURE_SKIP_THRESHOLD = 3;

export type ProviderHealthResult = "ok" | "hard_failed" | "auth_failed";

/** A provider the runner should skip (negative cache) on this call,
 *  with the reason so the caller can surface it. */
export interface ProviderSkipHint {
  providerType: ProviderChainType;
  reason: "credential_expired" | "backoff";
  /** When the negative cache lifts (ledger `nextRetryAt`). */
  retryAt: Date | null;
}

/**
 * The ledger surface the runner depends on. Injectable so the pure
 * fallback-chain unit tests can pass an in-memory / no-op implementation
 * without standing up Postgres, while production wires the durable
 * `postgresProviderHealthLedger`.
 */
export interface ProviderHealthLedger {
  /** Providers to skip right now for this user, keyed by chain type.
   *  Fails open (empty) on any error. */
  getSkipHints(
    userId: string,
  ): Promise<Map<ProviderChainType, ProviderSkipHint>>;
  /** Record a successful generation — clears any negative cache. */
  recordSuccess(userId: string, providerType: ProviderChainType): Promise<void>;
  /** Record a hard failure. `httpStatus` null = network/transport. */
  recordFailure(
    userId: string,
    providerType: ProviderChainType,
    httpStatus: number | null,
  ): Promise<void>;
}

/** Classify a failure status into the ledger result + cooldown. An
 *  auth-class status (401/403) is a dead credential; everything else
 *  that reaches the ledger is a transient hard failure. */
export function classifyFailure(httpStatus: number | null): {
  result: Exclude<ProviderHealthResult, "ok">;
  cooldownMs: number;
} {
  if (httpStatus === 401 || httpStatus === 403) {
    return { result: "auth_failed", cooldownMs: AUTH_FAILURE_COOLDOWN_MS };
  }
  return { result: "hard_failed", cooldownMs: HARD_FAILURE_COOLDOWN_MS };
}

/**
 * Durable, multi-instance-correct implementation backed by the
 * `provider_health` table. Writes use an atomic SQL upsert (the
 * rate-limiter pattern) so concurrent workers never clobber each other's
 * counters.
 */
export const postgresProviderHealthLedger: ProviderHealthLedger = {
  async getSkipHints(userId) {
    const hints = new Map<ProviderChainType, ProviderSkipHint>();
    try {
      const rows = await prisma.providerHealth.findMany({
        where: { userId, lastResult: { in: ["auth_failed", "hard_failed"] } },
        select: {
          providerType: true,
          lastResult: true,
          consecutiveFailures: true,
          nextRetryAt: true,
        },
      });
      const now = Date.now();
      for (const row of rows) {
        const provider = row.providerType as ProviderChainType;
        const inCooldown =
          row.nextRetryAt !== null && row.nextRetryAt.getTime() > now;
        if (!inCooldown) continue;
        if (row.lastResult === "auth_failed") {
          hints.set(provider, {
            providerType: provider,
            reason: "credential_expired",
            retryAt: row.nextRetryAt,
          });
        } else if (row.consecutiveFailures >= HARD_FAILURE_SKIP_THRESHOLD) {
          hints.set(provider, {
            providerType: provider,
            reason: "backoff",
            retryAt: row.nextRetryAt,
          });
        }
      }
    } catch {
      // Fail open — the ledger is an optimisation, not a gate.
      return new Map();
    }
    return hints;
  },

  async recordSuccess(userId, providerType) {
    try {
      // Atomic upsert; a success always clears the negative cache.
      await prisma.$executeRaw`
        INSERT INTO provider_health
          (id, user_id, provider_type, last_result, last_status,
           consecutive_failures, last_ok_at, last_failure_at,
           next_retry_at, updated_at)
        VALUES
          (gen_random_uuid()::text, ${userId}, ${providerType}, 'ok', NULL,
           0, NOW(), NULL, NULL, NOW())
        ON CONFLICT (user_id, provider_type) DO UPDATE SET
          last_result = 'ok',
          last_status = NULL,
          consecutive_failures = 0,
          last_ok_at = NOW(),
          next_retry_at = NULL,
          updated_at = NOW()
      `;
    } catch {
      // Fire-and-forget — a failed write never blocks the hot path.
    }
  },

  async recordFailure(userId, providerType, httpStatus) {
    const { result, cooldownMs } = classifyFailure(httpStatus);
    const interval = `${cooldownMs} milliseconds`;
    const status = httpStatus ?? null;
    try {
      // Atomic upsert. `consecutive_failures` accumulates across workers;
      // an auth failure forces the cooldown regardless of count, a hard
      // failure extends it. The fixed cooldown anchors on NOW() so a
      // fresh failure always re-arms the skip window.
      await prisma.$executeRaw`
        INSERT INTO provider_health
          (id, user_id, provider_type, last_result, last_status,
           consecutive_failures, last_ok_at, last_failure_at,
           next_retry_at, updated_at)
        VALUES
          (gen_random_uuid()::text, ${userId}, ${providerType}, ${result},
           ${status}, 1, NULL, NOW(), NOW() + ${interval}::interval, NOW())
        ON CONFLICT (user_id, provider_type) DO UPDATE SET
          last_result = ${result},
          last_status = ${status},
          consecutive_failures = provider_health.consecutive_failures + 1,
          last_failure_at = NOW(),
          next_retry_at = NOW() + ${interval}::interval,
          updated_at = NOW()
      `;
    } catch {
      // Fire-and-forget.
    }
  },
};

/**
 * Providers whose credential is currently known-bad (auth-class failure
 * inside the cooldown window) for a user. Drives the proactive
 * `credential_expired` surfacing — the gap that let an expired codex
 * token silently kill all generation. Fails open (empty).
 */
export async function findCredentialExpiredProviders(
  userId: string,
): Promise<ProviderChainType[]> {
  try {
    const rows = await prisma.providerHealth.findMany({
      where: {
        userId,
        lastResult: "auth_failed",
        nextRetryAt: { gt: new Date() },
      },
      select: { providerType: true },
    });
    return rows.map((r) => r.providerType as ProviderChainType);
  } catch {
    return [];
  }
}

/**
 * In-memory ledger for tests that want to assert the negative-cache
 * behaviour (auth failure benches a provider, success clears it)
 * without Postgres. Mirrors the Postgres semantics: auth failures skip
 * immediately, hard failures skip after the consecutive threshold.
 */
export function createInMemoryProviderHealthLedger(): ProviderHealthLedger & {
  /** Test inspection: current skip set for a user. */
  inspect(userId: string): Map<ProviderChainType, ProviderSkipHint>;
} {
  interface Row {
    result: ProviderHealthResult;
    status: number | null;
    consecutiveFailures: number;
    nextRetryAt: number | null;
  }
  const store = new Map<string, Map<ProviderChainType, Row>>();
  const rowsFor = (userId: string) => {
    let m = store.get(userId);
    if (!m) {
      m = new Map();
      store.set(userId, m);
    }
    return m;
  };
  const hintsFor = (userId: string) => {
    const out = new Map<ProviderChainType, ProviderSkipHint>();
    const now = Date.now();
    for (const [provider, row] of rowsFor(userId)) {
      if (row.nextRetryAt === null || row.nextRetryAt <= now) continue;
      if (row.result === "auth_failed") {
        out.set(provider, {
          providerType: provider,
          reason: "credential_expired",
          retryAt: new Date(row.nextRetryAt),
        });
      } else if (
        row.result === "hard_failed" &&
        row.consecutiveFailures >= HARD_FAILURE_SKIP_THRESHOLD
      ) {
        out.set(provider, {
          providerType: provider,
          reason: "backoff",
          retryAt: new Date(row.nextRetryAt),
        });
      }
    }
    return out;
  };
  return {
    async getSkipHints(userId) {
      return hintsFor(userId);
    },
    async recordSuccess(userId, providerType) {
      rowsFor(userId).set(providerType, {
        result: "ok",
        status: null,
        consecutiveFailures: 0,
        nextRetryAt: null,
      });
    },
    async recordFailure(userId, providerType, httpStatus) {
      const { result, cooldownMs } = classifyFailure(httpStatus);
      const prev = rowsFor(userId).get(providerType);
      const priorCount =
        prev && prev.result !== "ok" ? prev.consecutiveFailures : 0;
      rowsFor(userId).set(providerType, {
        result,
        status: httpStatus,
        consecutiveFailures: priorCount + 1,
        nextRetryAt: Date.now() + cooldownMs,
      });
    },
    inspect(userId) {
      return hintsFor(userId);
    },
  };
}
