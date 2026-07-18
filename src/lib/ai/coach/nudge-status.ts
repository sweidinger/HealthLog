/**
 * Shared Coach nudge-status read for the two entry points:
 *
 *   - `GET /api/insights/coach/nudge-status` (the client cell's endpoint), and
 *   - the `/coach` RSC wrapper (`src/app/coach/page.tsx`), which
 *     server-prefetches the same payload into a dehydrated TanStack cache so
 *     the auto-open-most-recent decision is available at hydrate instead of
 *     after the nudge → auto-open sequential round-trip.
 *
 * `unread` is true when an assistant message exists that is newer than the last
 * time the user opened the Coach (`User.coachLastSeenAt`, stamped by
 * `POST /api/insights/coach/seen`). Server-authoritative so the signal is
 * consistent across web + iOS.
 */
import { prisma } from "@/lib/db";

export interface CoachNudgeStatus {
  /** ISO timestamp of the newest assistant message, or null. */
  nudgedAt: string | null;
  unread: boolean;
  /** The conversation holding the newest assistant message, or null. */
  conversationId: string | null;
}

export async function readCoachNudgeStatus(
  userId: string,
): Promise<CoachNudgeStatus> {
  // The newest assistant message across the caller's conversations — the
  // proactive nudge writes one, and so does every normal Coach reply. We
  // intentionally key on assistant (not user) messages: the unread dot means
  // "the Coach said something", and the open-stamp clears it.
  const [lastAssistant, seen] = await Promise.all([
    prisma.coachMessage.findFirst({
      where: { role: "assistant", conversation: { userId } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, conversationId: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { coachLastSeenAt: true },
    }),
  ]);

  const nudgedAt = lastAssistant?.createdAt ?? null;
  const lastSeenAt = seen?.coachLastSeenAt ?? null;
  const unread =
    nudgedAt !== null && (lastSeenAt === null || lastSeenAt < nudgedAt);

  return {
    nudgedAt: nudgedAt ? nudgedAt.toISOString() : null,
    unread,
    conversationId: lastAssistant?.conversationId ?? null,
  };
}
