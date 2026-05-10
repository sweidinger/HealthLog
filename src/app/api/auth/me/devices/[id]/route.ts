/**
 * DELETE /api/auth/me/devices/[id]
 *
 * v1.4.23 W4 F7b — revoke a single device.
 *
 * Behaviour:
 *   1. Confirms the device row belongs to the current user (ownership
 *      boundary — 404 on cross-user attempts so callers can't probe
 *      another tenant's device ids).
 *   2. Revokes every active refresh token bound to this `deviceId` and
 *      the access tokens those refresh rows pair with.
 *   3. Deletes the `Device` row outright. Future re-pairing will create
 *      a fresh row.
 *
 * Note: this route does NOT touch the user's browser session cookie —
 * the session lives on `Session.id`, not `Device.id`. Browser logouts
 * keep using /api/auth/logout. The two surfaces address different
 * blast radii.
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
      // 404 on cross-user attempts — leaking "this id exists but isn't
      // yours" would let an attacker enumerate device ids.
      return apiError("Device not found", 404);
    }

    // Revoke every refresh token bound to this device + its paired
    // access tokens.
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
      },
    });
    annotate({
      action: { name: "auth.me.devices.revoke", entity_type: "device", entity_id: device.id },
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
