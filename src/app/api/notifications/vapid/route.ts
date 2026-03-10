import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import { getVapidConfig } from "@/lib/notifications/vapid-config";

/**
 * GET /api/notifications/vapid
 * Returns the VAPID public key for Web Push subscription.
 */
export const GET = apiHandler(async () => {
  annotate({ action: { name: "notifications.vapid" } });

  const config = await getVapidConfig();
  if (!config?.publicKey) {
    return apiError("Web Push is not configured", 503);
  }

  return apiSuccess({ publicKey: config.publicKey });
});
