import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { decrypt } from "@/lib/crypto";
import { unsubscribeWebhook } from "@/lib/withings/client";
import { getWithingsWebhookCallbackUrl } from "@/lib/withings/sync";

/**
 * Disconnect Withings integration for the current user.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "withings.disconnect" } });

  const connection = await prisma.withingsConnection.findUnique({
    where: { userId: user.id },
  });

  if (!connection) {
    return apiError("Keine Withings-Verbindung vorhanden", 404);
  }

  // Try to unsubscribe webhook (best-effort)
  try {
    const accessToken = decrypt(connection.accessToken);
    const callbackUrl = getWithingsWebhookCallbackUrl();
    await unsubscribeWebhook(accessToken, callbackUrl);
  } catch {
    // Ignore — token might be expired
  }

  await prisma.withingsConnection.delete({
    where: { userId: user.id },
  });

  await auditLog("withings.disconnect", {
    userId: user.id,
  });

  return apiSuccess({ disconnected: true });
});
