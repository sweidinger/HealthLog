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
import { requireAssistantSurface } from "@/lib/feature-flags";
import { readCoachNudgeStatus } from "@/lib/ai/coach/nudge-status";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  await requireAssistantSurface("coach");

  // Shared with the `/coach` RSC prefetch (`src/app/coach/page.tsx`) so both
  // readers compute the unread signal identically.
  return apiSuccess(await readCoachNudgeStatus(user.id));
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
