import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { markDisconnected } from "@/lib/integrations/status";

/**
 * Disconnect the user's Nightscout instance (v1.17.0).
 *
 * Clears the encrypted URL + token and the private-host flag on `User`, and
 * parks the `nightscout` integration ledger at `disconnected`. Already-ingested
 * glucose rows are left in place — disconnecting stops future syncs, it does
 * not delete the history the panel reads.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "nightscout.disconnect" } });

  const rl = await checkRateLimit(
    `nightscout-disconnect:${user.id}`,
    20,
    60_000,
  );
  if (!rl.allowed) {
    return apiError("Too many requests", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { nightscoutUrlEncrypted: true },
  });

  if (!dbUser?.nightscoutUrlEncrypted) {
    return apiError("No Nightscout connection", 404);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      nightscoutUrlEncrypted: null,
      nightscoutTokenEncrypted: null,
      nightscoutAllowPrivateHost: false,
    },
  });

  await auditLog("nightscout.disconnect", { userId: user.id });
  await markDisconnected(user.id, "nightscout");

  return apiSuccess({ disconnected: true });
});
