/**
 * Per-user, per-day token budget for the AI Coach.
 *
 * Why a separate ledger and not a generic counter on `User`:
 *   - The dispatcher must read the day's spend on every request — a
 *     scalar column would balloon write contention as concurrent
 *     requests race.
 *   - A `(userId, dateKey)` row partitions the writes by day and lets
 *     us add per-day analytics ("avg replies per active user") later
 *     without further migrations.
 *
 * `dateKey` is a UTC `YYYY-MM-DD` string. UTC, not Europe/Berlin: the
 * job runner that may seed off-hour tasks (planned v1.5) needs a
 * boundary that does not jump on DST. Display layers can format with
 * the user's timezone.
 */
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/api-handler";

export const MAX_TOKENS_PER_USER_PER_DAY = 25_000;

/**
 * Build the UTC day-key for a given clock. Defaults to "now".
 *
 * UTC choice: the budget guards spend against the operator's LLM
 * bill — the bill cycles at the provider's UTC midnight, so aligning
 * the local meter to the same boundary keeps reasoning trivial.
 */
export function buildDateKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Read the current day's token spend for `userId`. Returns 0 when no
 * row exists yet (first request of the day).
 */
export async function getDailyTokenSpend(
  userId: string,
  dateKey: string = buildDateKey(),
): Promise<number> {
  const row = await prisma.coachUsage.findUnique({
    where: { userId_dateKey: { userId, dateKey } },
    select: { totalTokens: true },
  });
  return row?.totalTokens ?? 0;
}

/**
 * Throw 429 when the user has already burned the day's budget. Called
 * BEFORE the provider chain runs — the route emits a refusal SSE
 * frame instead of hitting any upstream LLM.
 */
export async function enforceBudget(
  userId: string,
  dateKey: string = buildDateKey(),
  cap: number = MAX_TOKENS_PER_USER_PER_DAY,
): Promise<void> {
  const spent = await getDailyTokenSpend(userId, dateKey);
  if (spent >= cap) {
    throw new HttpError(429, "coach.budget.exceeded");
  }
}

/**
 * v1.18.7 (SENIOR-DEV HIGH) — atomically reserve budget BEFORE the provider
 * call, closing the read-then-write TOCTOU window.
 *
 * `enforceBudget` reads spend, then `recordSpend` bumps it only AFTER a
 * successful reply, so up to `rate-limit` (20/min) concurrent requests could
 * each read `spent < cap` before any spend landed and all hit the provider.
 * This instead does a single atomic SQL upsert that increments the day's
 * total by an ESTIMATED reservation and returns the new total. The caller
 * checks the returned total against the cap: if the reservation pushed it
 * over, the request is refused and the reservation refunded; otherwise the
 * call proceeds and the actual token count is reconciled afterwards. Mirrors
 * the `rate-limit.ts` atomic-upsert pattern — multi-instance correctness is
 * structural, not a hopeful read-then-write.
 *
 * The first request of a fresh day still lands cheaply via the upsert
 * `create` branch; `messageCount` is bumped at reservation time so a
 * reserved-but-failed turn still counts as an attempt.
 */
export interface ReserveBudgetResult {
  /** True when the reservation kept the day's total within the cap. */
  allowed: boolean;
  /** Tokens reserved by this call (refunded/reconciled by the caller). */
  reserved: number;
  /** The day's total AFTER this reservation (for observability). */
  totalAfter: number;
}

export async function reserveBudget(
  userId: string,
  estimatedTokens: number,
  dateKey: string = buildDateKey(),
  cap: number = MAX_TOKENS_PER_USER_PER_DAY,
): Promise<ReserveBudgetResult> {
  const reserved =
    Number.isFinite(estimatedTokens) && estimatedTokens > 0
      ? Math.floor(estimatedTokens)
      : 0;

  // Single atomic upsert-increment returning the new total. Two concurrent
  // requests serialise on the row's unique (user_id, date_key) constraint, so
  // each observes a distinct post-increment total — they cannot both read a
  // sub-cap value and both proceed.
  const rows = await prisma.$queryRaw<{ total_tokens: number }[]>`
    INSERT INTO coach_usage (id, user_id, date_key, total_tokens, message_count, created_at, updated_at)
    VALUES (gen_random_uuid()::text, ${userId}, ${dateKey}, ${reserved}, 1, NOW(), NOW())
    ON CONFLICT (user_id, date_key) DO UPDATE SET
      total_tokens = coach_usage.total_tokens + ${reserved},
      message_count = coach_usage.message_count + 1,
      updated_at = NOW()
    RETURNING total_tokens
  `;
  const totalAfter = Number(rows[0]?.total_tokens ?? reserved);

  // The cap is a ceiling on tokens already spent BEFORE this request, matching
  // the prior `spent >= cap` semantics: a request is allowed when the spend
  // PRIOR to its reservation was under the cap. So compare `totalAfter -
  // reserved` (the prior total) against the cap.
  const priorTotal = totalAfter - reserved;
  if (priorTotal >= cap) {
    // Already over before this request — refund the reservation + the
    // message-count bump and refuse.
    await refundReservation(userId, reserved, dateKey);
    return { allowed: false, reserved, totalAfter: priorTotal };
  }

  return { allowed: true, reserved, totalAfter };
}

/**
 * Reconcile a reservation against the actual tokens the provider reported.
 * `actual - reserved` is applied as a signed delta (clamped so the row never
 * goes negative). Called after every provider call — including empty /
 * sentinel / refusal replies, whose upstream tokens were still burned
 * (SENIOR-DEV MEDIUM: spend undercount).
 */
export async function reconcileSpend(
  userId: string,
  reserved: number,
  actualTokens: number,
  dateKey: string = buildDateKey(),
): Promise<void> {
  const actual =
    Number.isFinite(actualTokens) && actualTokens > 0
      ? Math.floor(actualTokens)
      : 0;
  const delta = actual - reserved;
  if (delta === 0) return;
  // Clamp at zero so a smaller-than-reserved actual can't drive the row
  // negative under a racing reconcile.
  await prisma.$executeRaw`
    UPDATE coach_usage
    SET total_tokens = GREATEST(0, total_tokens + ${delta}),
        updated_at = NOW()
    WHERE user_id = ${userId} AND date_key = ${dateKey}
  `;
}

/** Refund a reservation (tokens + the message-count bump) on a refusal. */
async function refundReservation(
  userId: string,
  reserved: number,
  dateKey: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE coach_usage
    SET total_tokens = GREATEST(0, total_tokens - ${reserved}),
        message_count = GREATEST(0, message_count - 1),
        updated_at = NOW()
    WHERE user_id = ${userId} AND date_key = ${dateKey}
  `;
}

export interface RecordSpendParams {
  userId: string;
  tokens: number;
  dateKey?: string;
}

/**
 * Bump the day's `totalTokens` and `messageCount` after a successful
 * assistant reply. Upsert keeps the first request of the day cheap;
 * subsequent calls land on the unique-index path.
 *
 * Negative or non-finite token figures are clamped to zero so a
 * provider that returns `tokensUsed: NaN` cannot poison the ledger.
 */
export async function recordSpend(params: RecordSpendParams): Promise<void> {
  const dateKey = params.dateKey ?? buildDateKey();
  const tokens =
    Number.isFinite(params.tokens) && params.tokens > 0
      ? Math.floor(params.tokens)
      : 0;
  await prisma.coachUsage.upsert({
    where: { userId_dateKey: { userId: params.userId, dateKey } },
    create: {
      userId: params.userId,
      dateKey,
      totalTokens: tokens,
      messageCount: 1,
    },
    update: {
      totalTokens: { increment: tokens },
      messageCount: { increment: 1 },
    },
  });
}
