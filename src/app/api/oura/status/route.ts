import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { getOuraCredentials } from "@/lib/oura/client";
import { getIntegrationStatus } from "@/lib/integrations/status";

/**
 * v1.17.0 (F4) — Oura connection status for the current user.
 *
 * `available` reports whether the server has the shared OAuth app configured.
 * `connected` is whether a token is stored. The ledger snapshot comes off the
 * shared `oura` IntegrationKey. The access / refresh tokens are NEVER returned.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "oura.status" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { ouraAccessTokenEncrypted: true },
  });

  const available = !!getOuraCredentials();
  const connected = !!dbUser?.ouraAccessTokenEncrypted;

  if (!connected) {
    return apiSuccess({ connected: false, configured: false, available });
  }

  const status = await getIntegrationStatus(user.id, "oura");

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
