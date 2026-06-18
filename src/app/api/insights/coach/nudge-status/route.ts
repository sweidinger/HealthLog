/**
 * GET /api/insights/coach/nudge-status — is there an unread Coach
 * message the caller has not opened yet?
 *
 * v1.18.6 (CCH-03) — the proactive Coach nudge now lands as a real
 * ASSISTANT message in the conversation rail (CCH-02), not as a
 * notification-only dispatch. The unread signal moved with it: instead
 * of anchoring on the `push_attempts` ledger (which is empty when no
 * push channel is configured, so the nudge was invisible), the status
 * compares the newest Coach assistant message against the
 * server-authoritative `User.coachLastSeenAt` stamp.
 *
 * `unread` is true when an assistant message exists that is newer than
 * the last time the user opened the Coach (drawer or page, which writes
 * `coachLastSeenAt` via `POST /api/insights/coach/seen`). A user who has
 * never opened the Coach reads any existing nudge as unread exactly
 * once. Server-authoritative so the signal is consistent across web +
 * iOS; the FAB keeps a local mirror only as an instant-paint
 * optimisation.
 *
 * `nudgedAt` carries the newest assistant-message timestamp so the FAB's
 * local seen-stamp keys on a stable value (kept for the existing client
 * contract).
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAssistantSurface } from "@/lib/feature-flags";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  await requireAssistantSurface("coach");

  // The newest assistant message across the caller's conversations — the
  // proactive nudge writes one, and so does every normal Coach reply. We
  // intentionally key on assistant (not user) messages: the unread dot
  // means "the Coach said something", and the open-stamp clears it.
  const [lastAssistant, seen] = await Promise.all([
    prisma.coachMessage.findFirst({
      where: { role: "assistant", conversation: { userId: user.id } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { coachLastSeenAt: true },
    }),
  ]);

  const nudgedAt = lastAssistant?.createdAt ?? null;
  const lastSeenAt = seen?.coachLastSeenAt ?? null;
  const unread =
    nudgedAt !== null && (lastSeenAt === null || lastSeenAt < nudgedAt);

  return apiSuccess({
    nudgedAt: nudgedAt ? nudgedAt.toISOString() : null,
    unread,
  });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
