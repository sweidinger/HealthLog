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
