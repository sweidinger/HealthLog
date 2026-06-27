/**
 * POST /api/auth/me/passkey-nudge/dismiss
 *
 * Permanently dismiss the "add a passkey" upgrade nudge for the calling user.
 * Cookie-only; idempotent. Sets `User.passkeyUpgradeNudgeDismissed = true`.
 */
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { user } = await requireCookieAuth();

  await prisma.user.update({
    where: { id: user.id },
    data: { passkeyUpgradeNudgeDismissed: true },
  });

  annotate({ action: { name: "auth.passkey.nudge.dismiss" } });
  return apiSuccess({ dismissed: true });
});
