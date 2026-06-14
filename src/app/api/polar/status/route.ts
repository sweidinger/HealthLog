import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { getPolarCredentials } from "@/lib/polar/client";
import { getIntegrationStatus } from "@/lib/integrations/status";

/**
 * v1.17.0 (F4) — Polar connection status for the current user.
 *
 * `available` reports whether the server has the shared OAuth app configured
 * (env client id/secret) so the card can grey out the connect button when the
 * operator hasn't set it up. `connected` is whether a token is stored. The
 * ledger snapshot (state / lastSuccessAt / lastError) comes off the shared
 * `polar` IntegrationKey. The access token + member id are NEVER returned.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "polar.status" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { polarAccessTokenEncrypted: true },
  });

  const available = !!getPolarCredentials();
  const connected = !!dbUser?.polarAccessTokenEncrypted;

  if (!connected) {
    return apiSuccess({ connected: false, configured: false, available });
  }

  const status = await getIntegrationStatus(user.id, "polar");

  return apiSuccess({
    connected: true,
    configured: true,
    available,
    state: status.state,
    lastSuccessAt: status.lastSuccessAt,
    lastAttemptAt: status.lastAttemptAt,
    lastError: status.lastError,
  });
});
