import { prisma } from "@/lib/db";
import { apiSuccess, apiError } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import { sendViaNtfy } from "@/lib/notifications/senders/ntfy";
import type { NtfyChannelConfig } from "@/lib/notifications/types";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

/**
 * POST: Send a test notification via ntfy.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(`ntfy-test:${user.id}`, 5, 5 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximal 5 Tests in 5 Minuten", 429);
  }

  const channel = await prisma.notificationChannel.findUnique({
    where: {
      userId_type: { userId: user.id, type: "NTFY" },
    },
  });

  if (!channel) {
    return apiError("ntfy ist nicht konfiguriert", 400);
  }

  const config = JSON.parse(decrypt(channel.config)) as NtfyChannelConfig;

  if (!config.serverUrl || !config.topic) {
    return apiError("Server-URL und Topic sind erforderlich", 400);
  }

  const success = await sendViaNtfy(config, {
    eventType: "SYSTEM_ALERT",
    userId: user.id,
    title: "HealthLog Test",
    message:
      "HealthLog: Verbindung erfolgreich! ntfy-Benachrichtigungen sind aktiv.",
  });

  if (!success) {
    return apiError("Testnachricht konnte nicht gesendet werden", 500);
  }

  annotate({ action: { name: "settings.ntfy.test" }, meta: { success: true } });

  return apiSuccess({ sent: true });
});
