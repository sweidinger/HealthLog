import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { emailSettingsSchema } from "@/lib/validations/notifications";
import { encrypt, decrypt } from "@/lib/crypto";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { isEmailConfigured } from "@/lib/notifications/senders/email-config";

/**
 * Email channel config (v1.17.1).
 * GET: per-user recipient + opt-in, plus `smtpConfigured` so the UI can hide
 *      the card on an instance where the operator hasn't set `SMTP_*`.
 * PUT: upsert recipient + enabled.
 *
 * The SMTP transport (host/port/auth/from) is operator-supplied via env; only
 * the recipient address is per-user, so SMTP credentials never enter a user's
 * encrypted channel blob.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const smtpConfigured = isEmailConfigured();

  const channel = await prisma.notificationChannel.findUnique({
    where: { userId_type: { userId: user.id, type: "EMAIL" } },
  });

  if (!channel) {
    return apiSuccess({ enabled: false, recipient: "", smtpConfigured });
  }

  const config = JSON.parse(decrypt(channel.config)) as { recipient: string };

  annotate({ action: { name: "settings.email.get" } });

  return apiSuccess({
    enabled: channel.enabled,
    recipient: config.recipient,
    smtpConfigured,
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  if (!isEmailConfigured()) {
    return apiError("Email is not configured on this instance", 400);
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = emailSettingsSchema.safeParse(body);
  if (!parsed.success) return apiError("Invalid data", 422);

  const { recipient, enabled } = parsed.data;

  if (enabled && !recipient) {
    return apiError("A recipient address is required when email is enabled", 422);
  }

  const config = JSON.stringify({ recipient: recipient || "" });
  const encryptedConfig = encrypt(config);

  await prisma.notificationChannel.upsert({
    where: { userId_type: { userId: user.id, type: "EMAIL" } },
    create: {
      userId: user.id,
      type: "EMAIL",
      enabled,
      config: encryptedConfig,
    },
    update: { enabled, config: encryptedConfig },
  });

  annotate({ action: { name: "settings.email.update" }, meta: { enabled } });

  return apiSuccess({ saved: true });
});
