import { prisma } from "@/lib/db";

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

interface ParsedStatusCache {
  dateKey?: string;
  locale?: string;
  text?: string;
  summary?: string;
  providerType?: string;
  model?: string;
  tokensUsed?: number | null;
  timeout?: boolean;
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
