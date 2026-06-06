import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import { webPushSubscriptionSchema } from "@/lib/validations/notifications";
import { z } from "zod/v4";

// The endpoint is later dialled by `web-push`, which does its own internal
// fetch that bypasses safeFetch — so the SSRF floor has to be enforced here
// at input time. `webPushSubscriptionSchema` requires https + isPublicUrl
// (blocks loopback/link-local/metadata/internal hosts). The sender applies
// the same check again at egress time as defence-in-depth.
const subscribeSchema = webPushSubscriptionSchema;

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

/**
 * POST /api/notifications/web-push
 * Save a Web Push subscription for the current user.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.web-push.subscribe" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Invalid JSON data", 422);
  }

  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) return apiError("Invalid data", 422);

  const { endpoint, keys } = parsed.data;
  const userAgent = request.headers.get("user-agent") ?? undefined;

  // Upsert subscription (encrypt sensitive keys)
  await prisma.pushSubscription.upsert({
    where: {
      userId_endpoint: {
        userId: user.id,
        endpoint,
      },
    },
    create: {
      userId: user.id,
      endpoint,
      p256dh: encrypt(keys.p256dh),
      auth: encrypt(keys.auth),
      userAgent,
    },
    update: {
      p256dh: encrypt(keys.p256dh),
      auth: encrypt(keys.auth),
      userAgent,
    },
  });

  // Ensure a WEB_PUSH notification channel exists for this user
  const existingChannel = await prisma.notificationChannel.findFirst({
    where: { userId: user.id, type: "WEB_PUSH" },
  });

  if (!existingChannel) {
    await prisma.notificationChannel.create({
      data: {
        userId: user.id,
        type: "WEB_PUSH",
        enabled: true,
        config: encrypt(JSON.stringify({})),
      },
    });
  }

  return apiSuccess({ subscribed: true });
});

/**
 * DELETE /api/notifications/web-push
 * Remove a Web Push subscription.
 */
export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.web-push.unsubscribe" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("Invalid JSON data", 422);
  }

  const parsed = unsubscribeSchema.safeParse(body);
  if (!parsed.success) return apiError("Invalid data", 422);

  await prisma.pushSubscription.deleteMany({
    where: {
      userId: user.id,
      endpoint: parsed.data.endpoint,
    },
  });

  return apiSuccess({ unsubscribed: true });
});
