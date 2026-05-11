/**
 * POST /api/devices
 *
 * Native-client device registration. The iOS app calls this on login,
 * on APNs token rotation, and whenever a fresh `apnsToken` arrives from
 * `application:didRegisterForRemoteNotificationsWithDeviceToken:`. We
 * upsert by `token` (the legacy generic identifier).
 *
 * Cross-user-hijack guard:
 *   * A device `token` belongs to exactly one user. Re-registering the
 *     same value under a different account returns 409. APNs tokens
 *     aren't secrets, so trusting wire input would let anyone who
 *     learns one redirect another user's pushes.
 *   * The same guard applies to `apnsToken` — supplying an `apnsToken`
 *     that's already registered to a different user returns 409 with
 *     reason `apns_token_owned_by_other_user`.
 *
 * APNs registration:
 *   * `apnsToken` and `apnsEnvironment` are paired — supplying one
 *     without the other returns 422. The iOS client picks the gateway
 *     (`sandbox` for Debug builds, `production` for Release / TestFlight)
 *     because the server has no way to tell from the token alone.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { encrypt } from "@/lib/crypto";

const deviceSchema = z
  .object({
    token: z
      .string()
      .min(8)
      .max(512)
      .regex(/^[A-Za-z0-9+/=._:-]+$/, "Invalid token format"),
    bundleId: z.string().min(1).max(128),
    locale: z.string().min(2).max(16).optional(),
    appVersion: z.string().min(1).max(32).optional(),
    model: z.string().min(1).max(64).optional(),
    // APNs-specific pair — the iOS client populates these once it has
    // an APNs token from the OS callback. Hex string per Apple's spec
    // (64 chars on most devices; cap at 256 for forward compat).
    apnsToken: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[A-Fa-f0-9]+$/, "apnsToken must be hex")
      .optional(),
    apnsEnvironment: z.enum(["sandbox", "production"]).optional(),
  })
  .refine(
    (v) =>
      (v.apnsToken === undefined && v.apnsEnvironment === undefined) ||
      (v.apnsToken !== undefined && v.apnsEnvironment !== undefined),
    {
      message:
        "apnsToken and apnsEnvironment must be supplied together or both omitted",
      path: ["apnsEnvironment"],
    },
  );

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error } = await safeJson(request);
  if (error) return error;

  const parsed = deviceSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const {
    token,
    bundleId,
    locale,
    appVersion,
    model,
    apnsToken,
    apnsEnvironment,
  } = parsed.data;

  // APNs-token cross-user-hijack guard: APNs tokens aren't secrets, so
  // accepting one already owned by another user would let any client
  // who learns one redirect that user's pushes. Reject before any
  // upsert so we never accidentally transfer ownership.
  if (apnsToken) {
    const existingApns = await prisma.device.findFirst({
      where: { apnsToken, NOT: { userId: user.id } },
      select: { id: true },
    });
    if (existingApns) {
      await auditLog("device.register.denied", {
        userId: user.id,
        details: {
          reason: "apns_token_owned_by_other_user",
          deviceId: existingApns.id,
        },
      });
      return apiError(
        "APNs token already registered to another account",
        409,
      );
    }
  }

  const existing = await prisma.device.findUnique({ where: { token } });
  let id: string;
  if (existing) {
    // Cross-user-hijack guard: a device-token belongs to exactly one user.
    // Re-registering the same token under a different account is rejected
    // — APNs tokens aren't a secret, so trusting the wire input would let
    // anyone who learns/guesses a token redirect another user's pushes.
    if (existing.userId !== user.id) {
      await auditLog("device.register.denied", {
        userId: user.id,
        details: { reason: "token_owned_by_other_user", deviceId: existing.id },
      });
      return apiError(
        "Device token already registered to another account",
        409,
      );
    }
    const updated = await prisma.device.update({
      where: { token },
      data: {
        platform: "ios",
        bundleId,
        locale: locale ?? null,
        appVersion: appVersion ?? null,
        model: model ?? null,
        apnsToken: apnsToken ?? null,
        apnsEnvironment: apnsEnvironment ?? null,
        lastSeen: new Date(),
      },
      select: { id: true },
    });
    id = updated.id;
  } else {
    const created = await prisma.device.create({
      data: {
        userId: user.id,
        platform: "ios",
        token,
        bundleId,
        locale: locale ?? null,
        appVersion: appVersion ?? null,
        model: model ?? null,
        apnsToken: apnsToken ?? null,
        apnsEnvironment: apnsEnvironment ?? null,
      },
      select: { id: true },
    });
    id = created.id;
  }

  // Auto-create the APNS NotificationChannel row when the device
  // registers with an apnsToken. Without this row the dispatcher's APNS
  // branch (`dispatcher.ts:41-49`) never fires for the user — every
  // production iOS install would otherwise need a manual settings
  // toggle that doesn't exist. Mirrors the legacy Telegram on-first-
  // dispatch auto-migration, but eager so the very first reminder
  // after device registration already routes through APNs. Config is
  // an encrypted empty record by design — the per-device token +
  // environment live on the Device row.
  if (apnsToken) {
    await prisma.notificationChannel.upsert({
      where: { userId_type: { userId: user.id, type: "APNS" } },
      create: {
        userId: user.id,
        type: "APNS",
        enabled: true,
        config: encrypt("{}"),
      },
      update: {},
    });
  }

  await auditLog("devices.register", {
    userId: user.id,
    details: {
      deviceId: id,
      bundleId,
      model: model ?? null,
      hasApnsToken: Boolean(apnsToken),
      apnsEnvironment: apnsEnvironment ?? null,
    },
  });

  annotate({
    action: { name: "devices.register", entity_type: "device", entity_id: id },
  });

  return apiSuccess({ id }, 201);
});
