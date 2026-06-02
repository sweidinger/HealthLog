import { prisma } from "@/lib/db";
import { hasUsableStatusProvider } from "@/lib/insights/status-provider";
import {
  enqueueStatusGeneration,
  type InsightStatusScope,
} from "@/lib/jobs/insight-status-generate-shared";
import { annotate } from "@/lib/logging/context";

/**
 * Shared cache-read for the seven `*-status.ts` insight generators.
 *
 * Every generator persists its assessment as an `auditLog` row keyed
 * `insights.<metric>-status.<locale>` whose `details` JSON carries
 * `{ dateKey, locale, text, providerType, model, tokensUsed }`. On the
 * next mount the generator reads the most recent such row and, if it is
 * still for today, serves it without re-hitting the provider.
 *
 * The timeout fallback used to poison this read. When a provider call
 * exceeded the status budget the route persisted a `model:"timeout-stub"`
 * / `timeout:true` row carrying the generic no-key text under the SAME
 * `text` field a real assessment uses. The cache-read only checked
 * `dateKey === today && text` — so the stub looked like a valid
 * assessment and stuck until midnight, hiding the real data-driven text
 * for the rest of the day.
 *
 * `readFreshStatusText` is the one cache-read every standard generator
 * shares. It rejects stubs explicitly so a single stall no longer pins
 * the fallback for the day, and a fresh generation is attempted instead.
 */

/**
 * The single source of truth for the per-status cache-action shape.
 *
 * Every per-metric assessment is persisted as an `auditLog` row whose
 * `action` is `insights.<scope>-status.<locale>`. The shape IS the cache
 * key, so building it by hand in multiple places risks the same silent
 * drift the queryKey factory guards against on the client. `statusCacheAction`
 * is the one builder; `statusCacheActionPrefix` is its locale-agnostic
 * sibling for the `startsWith` eviction that drops every locale variant of a
 * scope at once.
 */
export function statusCacheAction(scope: string, locale: string): string {
  return `insights.${scope}-status.${locale}`;
}

/** Locale-agnostic prefix for `startsWith`-eviction of every locale of a scope. */
export function statusCacheActionPrefix(scope: string): string {
  return `insights.${scope}-status.`;
}

interface ParsedStatusCache {
  dateKey?: string;
  locale?: string;
  text?: string;
  summary?: string;
  providerType?: string;
  model?: string;
  tokensUsed?: number | null;
  timeout?: boolean;
  /** v1.8.3 — ISO timestamp before which a timeout stub suppresses re-enqueue. */
  retryAt?: string;
}

/**
 * A cached row is a timeout stub when it carries the sentinel marker the
 * timeout path writes. Either flag is sufficient — older stub rows may
 * predate one of the two markers, so both are honoured.
 */
export function isTimeoutStub(parsed: {
  model?: string;
  timeout?: boolean;
}): boolean {
  return parsed.model === "timeout-stub" || parsed.timeout === true;
}

export interface FreshStatusCacheHit {
  text: string;
  updatedAt: string;
}

/**
 * Read the latest cached assessment for `(userId, cacheAction)` and
 * return its text only when it is (a) for today and (b) NOT a timeout
 * stub. Returns `null` on a miss, a stale day, a stub, or a malformed
 * payload — every one of those means the caller should regenerate.
 *
 * `force` short-circuits to `null` so a forced regeneration never reads
 * the cache. The DB read is still skipped entirely under `force` to
 * keep the forced path cheap.
 */
export async function readFreshStatusText(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  force: boolean;
}): Promise<FreshStatusCacheHit | null> {
  const { userId, cacheAction, todayKey, force } = args;
  if (force) return null;

  const latestCache = await prisma.auditLog.findFirst({
    where: { userId, action: cacheAction },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });
  if (!latestCache?.details) return null;

  try {
    const parsed = JSON.parse(latestCache.details) as ParsedStatusCache;
    if (parsed.dateKey !== todayKey) return null;
    if (isTimeoutStub(parsed)) return null;
    if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
      return null;
    }
    return {
      text: parsed.text,
      updatedAt: latestCache.createdAt.toISOString(),
    };
  } catch {
    // Malformed cache payload — treat as a miss and regenerate.
    return null;
  }
}

export interface LastGoodStatusHit {
  text: string;
  updatedAt: string;
}

/**
 * v1.8.7 — read the most recent NON-stub assessment for `(userId,
 * cacheAction)` regardless of which day it was generated. This is the
 * stale-while-revalidate source: when today's cache is a miss the
 * read-only path can still serve yesterday's (or older) good text
 * instantly while a fresh generation is warmed out of band, so opening a
 * category never drops to the "preparing" skeleton if an assessment was
 * ever produced. Returns `null` only when there is genuinely no prior
 * assessment (or every prior row is a timeout stub / malformed).
 */
export async function readLastGoodStatusText(args: {
  userId: string;
  cacheAction: string;
}): Promise<LastGoodStatusHit | null> {
  const { userId, cacheAction } = args;
  const rows = await prisma.auditLog.findMany({
    where: { userId, action: cacheAction },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { createdAt: true, details: true },
  });
  for (const row of rows) {
    if (!row.details) continue;
    try {
      const parsed = JSON.parse(row.details) as ParsedStatusCache;
      if (isTimeoutStub(parsed)) continue;
      if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
        continue;
      }
      return { text: parsed.text, updatedAt: row.createdAt.toISOString() };
    } catch {
      // Malformed payload — skip and look further back.
      continue;
    }
  }
  return null;
}

/**
 * Outcome of the read-only cache-miss resolution. The generators map this
 * onto their public return shape:
 *   - `no-provider` → `{ hasProvider: false, text: <no-key fallback> }`
 *   - `preparing`   → `{ hasProvider: true, text: <last-good|null>, preparing: true }`
 *
 * v1.8.7 — `preparing` now carries the last good assessment (if any) so
 * the card renders the previous text immediately (stale-while-revalidate)
 * instead of a skeleton while the worker re-warms the cache.
 *
 * v1.9.0 — `revalidating` is true only when last-good text is served AND a
 * fresh generation was actually enqueued (the open-card refresh case). When
 * the served text is terminal the card otherwise stops polling and never
 * sees the freshly-warmed assessment until a remount; the flag keeps the
 * bounded poll alive until the new row lands. It is false on the
 * suppressed-stub branch (no enqueue, so nothing is in flight) and whenever
 * there is no last-good text (that path already polls via `preparing`).
 */
export type ReadOnlyMissOutcome =
  | { kind: "no-provider" }
  | {
      kind: "preparing";
      lastGood: LastGoodStatusHit | null;
      revalidating: boolean;
    };

/**
 * v1.8.3 — resolve what a read-only status generation should return on a
 * cache miss WITHOUT running the heavy SQL gather or the blocking LLM
 * round-trip. This is the core of the holistic freeze fix: a navigation
 * request must never await an uncapped provider call.
 *
 * On a miss the route either:
 *   - finds no usable provider → returns `no-provider` (the card shows the
 *     no-key fallback; nothing to generate), or
 *   - finds a provider → fire-and-forget enqueues a generation job and
 *     returns `preparing` (the card shows a preparing state and the client
 *     polls until the worker warms the cache).
 *
 * The provider probe is a cheap chain-resolve (no completion), so the GET
 * stays sub-second even on a cold cache.
 */
export async function resolveReadOnlyStatusMiss(args: {
  userId: string;
  metric: InsightStatusScope;
  locale: "de" | "en";
}): Promise<ReadOnlyMissOutcome> {
  const hasProvider = await hasUsableStatusProvider(args.userId);
  if (!hasProvider) return { kind: "no-provider" };

  const cacheAction = statusCacheAction(args.metric, args.locale);

  // v1.8.7 — stale-while-revalidate. Surface the last good (non-stub)
  // assessment for this scope so the card renders the previous text
  // immediately instead of a skeleton while a refresh is warmed. Null when
  // no assessment was ever produced — only then does the card show
  // "preparing"/"no analysis yet".
  const lastGood = await readLastGoodStatusText({
    userId: args.userId,
    cacheAction,
  });

  // v1.8.3 — honour the short-TTL negative cache. If the worker recently
  // hit a provider stall it wrote a `retryAt` stub; re-enqueuing on every
  // navigation while the provider is still degraded would be a storm. While
  // the stub is fresh, stay in `preparing` without enqueuing; once it goes
  // stale (or never existed) enqueue a fresh generation.
  if (await hasFreshTimeoutStub({ userId: args.userId, cacheAction })) {
    annotate({
      action: { name: "insights.status.preparing" },
      meta: { metric: args.metric, suppressed_enqueue: true },
    });
    // No enqueue on this branch — nothing is in flight, so the open card has
    // nothing to revalidate against. It still polls via `preparing` when
    // there is no last-good text to show.
    return { kind: "preparing", lastGood, revalidating: false };
  }

  // Enqueue out of band — do NOT await an LLM here. The enqueue itself is
  // best-effort and de-duped per (user, metric, locale).
  await enqueueStatusGeneration({
    userId: args.userId,
    metric: args.metric,
    locale: args.locale,
  });
  annotate({
    action: { name: "insights.status.preparing" },
    meta: { metric: args.metric, stale_served: lastGood !== null },
  });
  // A fresh generation is now in flight. When last-good text is served the
  // payload is otherwise terminal (`preparing` is false), so the open card
  // would stop polling and never pick up the warmed assessment. Signal
  // `revalidating` so the bounded poll stays alive until the new row lands.
  return { kind: "preparing", lastGood, revalidating: lastGood !== null };
}

/**
 * True when the most recent cache row for `(userId, cacheAction)` is a
 * timeout stub whose `retryAt` is still in the future. Used by the
 * read-only resolver to suppress a re-enqueue storm while a provider is
 * degraded. A stub without `retryAt` (legacy) is treated as stale so the
 * resolver retries, matching the pre-v1.8.3 "transient miss" behaviour.
 */
async function hasFreshTimeoutStub(args: {
  userId: string;
  cacheAction: string;
}): Promise<boolean> {
  const latest = await prisma.auditLog.findFirst({
    where: { userId: args.userId, action: args.cacheAction },
    orderBy: { createdAt: "desc" },
    select: { details: true },
  });
  if (!latest?.details) return false;
  try {
    const parsed = JSON.parse(latest.details) as ParsedStatusCache;
    if (!isTimeoutStub(parsed)) return false;
    if (typeof parsed.retryAt !== "string") return false;
    return new Date(parsed.retryAt).getTime() > Date.now();
  } catch {
    return false;
  }
}
