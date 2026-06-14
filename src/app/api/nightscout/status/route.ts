import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { getIntegrationStatus } from "@/lib/integrations/status";

/**
 * Nightscout connection status for the current user (v1.17.0).
 *
 * `configured` is whether an instance URL is stored (the connect marker — a
 * fully-public instance has no token). The ledger snapshot (state /
 * lastSuccessAt / lastError) comes off the shared `nightscout` IntegrationKey
 * so the Settings card surfaces the same connected / error / parked pill the
 * other integrations use. The stored URL is echoed back (host only is enough
 * for the card, but the URL is the user's own and not a secret); the token is
 * NEVER returned.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "nightscout.status" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      nightscoutUrlEncrypted: true,
      nightscoutTokenEncrypted: true,
      nightscoutAllowPrivateHost: true,
    },
  });

  const configured = !!dbUser?.nightscoutUrlEncrypted;

  if (!configured) {
    return apiSuccess({ connected: false, configured: false });
  }

  const status = await getIntegrationStatus(user.id, "nightscout");

  return apiSuccess({
    connected: true,
    configured: true,
    hasToken: !!dbUser?.nightscoutTokenEncrypted,
    allowPrivateHost: dbUser?.nightscoutAllowPrivateHost ?? false,
    state: status.state,
    lastSuccessAt: status.lastSuccessAt,
    lastAttemptAt: status.lastAttemptAt,
    lastError: status.lastError,
  });
});
