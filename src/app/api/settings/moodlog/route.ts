import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { apiSuccess, apiError } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import { moodLogCredentialsSchema } from "@/lib/validations/moodlog";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }

  const parsed = moodLogCredentialsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Ungueltige Eingabe", 422);
  }

  const { url, apiKey } = parsed.data;

  // Generate webhook secret if not yet set
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { moodLogWebhookSecret: true },
  });

  const webhookSecret =
    existing?.moodLogWebhookSecret ?? `mb_${randomBytes(32).toString("hex")}`;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      moodLogUrlEncrypted: encrypt(url),
      moodLogApiKeyEncrypted: encrypt(apiKey),
      moodLogEnabled: true,
      moodLogWebhookSecret: webhookSecret,
    },
  });

  annotate({ action: { name: "settings.moodlog.update" } });

  return apiSuccess({
    configured: true,
    enabled: true,
    webhookSecret,
  });
});

export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();

  // Delete all mood entries for this user
  await prisma.moodEntry.deleteMany({
    where: { userId: user.id },
  });

  // Clear credentials
  await prisma.user.update({
    where: { id: user.id },
    data: {
      moodLogUrlEncrypted: null,
      moodLogApiKeyEncrypted: null,
      moodLogEnabled: false,
      moodLogLastSyncedAt: null,
      moodLogWebhookSecret: null,
    },
  });

  annotate({ action: { name: "settings.moodlog.disconnect" } });

  return apiSuccess({ disconnected: true });
});
