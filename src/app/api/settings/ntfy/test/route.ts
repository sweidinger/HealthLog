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
    return apiError("Maximum 5 tests in 5 minutes", 429);
  }

  const channel = await prisma.notificationChannel.findUnique({
    where: {
      userId_type: { userId: user.id, type: "NTFY" },
    },
  });

  if (!channel) {
    return apiError("ntfy is not configured", 400);
  }

  const config = JSON.parse(decrypt(channel.config)) as NtfyChannelConfig;

  if (!config.serverUrl || !config.topic) {
    return apiError("Server URL and topic are required", 400);
  }

  const success = await sendViaNtfy(config, {
    eventType: "SYSTEM_ALERT",
    userId: user.id,
    title: "HealthLog Test",
    message:
      "HealthLog: Connection successful! ntfy notifications are active.",
  });

  if (!success) {
    return apiError("Failed to send test message", 500);
  }

  annotate({ action: { name: "settings.ntfy.test" }, meta: { success: true } });

  return apiSuccess({ sent: true });
});
