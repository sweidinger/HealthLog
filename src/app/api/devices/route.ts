/**
 * POST /api/devices
 *
 * APNs device registration. Native clients call this on login and on
 * APNs token rotation. We upsert by `token`; sending the same token on a
 * different account simply transfers ownership.
 *
 * No APNs send-side logic lives here — that ships in Phase 8.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";

const deviceSchema = z.object({
  token: z
    .string()
    .min(8)
    .max(512)
    .regex(/^[A-Za-z0-9+/=._:-]+$/, "Invalid token format"),
  bundleId: z.string().min(1).max(128),
  locale: z.string().min(2).max(16).optional(),
  appVersion: z.string().min(1).max(32).optional(),
  model: z.string().min(1).max(64).optional(),
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error } = await safeJson(request);
  if (error) return error;

  const parsed = deviceSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { token, bundleId, locale, appVersion, model } = parsed.data;

  const existing = await prisma.device.findUnique({ where: { token } });
  let id: string;
  if (existing) {
    const updated = await prisma.device.update({
      where: { token },
      data: {
        userId: user.id,
        platform: "ios",
        bundleId,
        locale: locale ?? null,
        appVersion: appVersion ?? null,
        model: model ?? null,
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
      },
      select: { id: true },
    });
    id = created.id;
  }

  await auditLog("devices.register", {
    userId: user.id,
    details: { deviceId: id, bundleId, model: model ?? null },
  });

  annotate({
    action: { name: "devices.register", entity_type: "device", entity_id: id },
  });

  return apiSuccess({ id }, 201);
});
