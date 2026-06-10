/**
 * GET /api/insights/coach/nudge-status — has the proactive Coach nudge
 * something the caller has not engaged with yet?
 *
 * v1.16.1 — feeds the floating Coach bubble: the bubble renders only
 * while an unseen Coach-initiated nudge exists, instead of being a
 * permanent FAB. "Unseen" is derived, not stored: the latest successful
 * `COACH_NUDGE` dispatch (the `push_attempts` ledger the nudge cron
 * already anchors its frequency cap on) counts as read once the user
 * has sent a Coach message after it. The client additionally remembers
 * a local "seen" stamp so opening the chat without sending also clears
 * the bubble on that device.
 *
 * No new table, no migration: both timestamps come from existing rows,
 * scoped to the caller.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireAssistantSurface } from "@/lib/feature-flags";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  await requireAssistantSurface("coach");

  const [lastNudge, lastUserMessage] = await Promise.all([
    prisma.pushAttempt.findFirst({
      where: { userId: user.id, eventType: "COACH_NUDGE", result: "ok" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.coachMessage.findFirst({
      where: { role: "user", conversation: { userId: user.id } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  const nudgedAt = lastNudge?.createdAt ?? null;
  const unread =
    nudgedAt !== null &&
    (lastUserMessage === null || lastUserMessage.createdAt < nudgedAt);

  return apiSuccess({
    nudgedAt: nudgedAt ? nudgedAt.toISOString() : null,
    unread,
  });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
