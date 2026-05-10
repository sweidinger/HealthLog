/**
 * DELETE /api/devices/[id]
 *
 * v1.4.23 W4 F7b alternate iOS endpoint — mirror of
 * `DELETE /api/auth/me/devices/[id]` for the v1.5 iOS app's
 * token-rotation cleanup path. Same ownership boundary, same audit
 * trail, same cascade.
 *
 * The duplication is deliberate: the W3 open question called out
 * needing a native-friendly URL for the iOS client's APNs rotation
 * loop, and the `/api/auth/me/...` path is built for the settings-
 * surface listing. Two URLs, one implementation: the underlying
 * Prisma calls are identical to keep the audit trail consistent.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const DELETE = apiHandler(
  async (_request: NextRequest, context: RouteContext) => {
    const { user } = await requireAuth();
    const { id } = await context.params;

    const device = await prisma.device.findUnique({
      where: { id },
      select: { id: true, userId: true, model: true, bundleId: true },
    });

    if (!device || device.userId !== user.id) {
      return apiError("Device not found", 404);
    }

    const liveRefreshTokens = await prisma.refreshToken.findMany({
      where: { userId: user.id, deviceId: device.id, revokedAt: null },
      select: { accessTokenHash: true },
    });
    const revokedAt = new Date();
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, deviceId: device.id, revokedAt: null },
      data: { revokedAt },
    });
    const accessHashes = liveRefreshTokens
      .map((r) => r.accessTokenHash)
      .filter((v): v is string => Boolean(v));
    if (accessHashes.length > 0) {
      await prisma.apiToken.updateMany({
        where: { tokenHash: { in: accessHashes }, revoked: false },
        data: { revoked: true },
      });
    }

    await prisma.device.delete({ where: { id: device.id } });

    await auditLog("devices.revoke", {
      userId: user.id,
      details: {
        deviceId: device.id,
        label: device.model ?? device.bundleId ?? null,
        refreshTokensRevoked: liveRefreshTokens.length,
        accessTokensRevoked: accessHashes.length,
        via: "ios.rotation",
      },
    });
    annotate({
      action: { name: "devices.revoke", entity_type: "device", entity_id: device.id },
      meta: {
        refresh_tokens_revoked: liveRefreshTokens.length,
        access_tokens_revoked: accessHashes.length,
      },
    });

    return apiSuccess({
      id: device.id,
      revoked: true,
      refreshTokensRevoked: liveRefreshTokens.length,
      accessTokensRevoked: accessHashes.length,
    });
  },
);
