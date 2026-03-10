import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "moodlog.status" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      moodLogUrlEncrypted: true,
      moodLogEnabled: true,
      moodLogLastSyncedAt: true,
      moodLogWebhookSecret: true,
    },
  });

  const entryCount = await prisma.moodEntry.count({
    where: { userId: user.id },
  });

  return apiSuccess({
    configured: Boolean(dbUser?.moodLogUrlEncrypted),
    enabled: dbUser?.moodLogEnabled ?? false,
    lastSyncedAt: dbUser?.moodLogLastSyncedAt ?? null,
    entryCount,
    webhookSecret: dbUser?.moodLogWebhookSecret ?? null,
  });
});
