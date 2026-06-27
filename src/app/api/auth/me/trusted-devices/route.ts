/**
 * GET    /api/auth/me/trusted-devices — list the caller's trusted devices.
 * DELETE /api/auth/me/trusted-devices — revoke ALL of them ("forget every
 *        device"); also clears the caller's own trusted-device cookie.
 *
 * Cookie-only (`requireCookieAuth`) — a trusted device is a browser concept and
 * a Bearer client never manages one. Returns only metadata: a coarse, IP-free
 * device label and the lifecycle timestamps; never the token or its hash.
 */
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { getClientIp } from "@/lib/api-response";
import {
  listTrustedDevices,
  revokeAllTrustedDevices,
  clearTrustedDeviceCookie,
} from "@/lib/auth/trusted-device";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireCookieAuth();
  annotate({ action: { name: "auth.trusted_device.list" } });

  const devices = await listTrustedDevices(user.id);
  return apiSuccess({
    devices: devices.map((d) => ({
      id: d.id,
      label: d.label,
      createdAt: d.createdAt.toISOString(),
      lastUsedAt: d.lastUsedAt.toISOString(),
      expiresAt: d.expiresAt.toISOString(),
      isCurrent: d.isCurrent,
    })),
  });
});

export const DELETE = apiHandler(async (req: Request) => {
  const { user } = await requireCookieAuth();

  const revoked = await revokeAllTrustedDevices(user.id);
  await clearTrustedDeviceCookie();

  await auditLog("auth.trusted_device.revoke_all", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { revoked },
  });
  annotate({
    action: { name: "auth.trusted_device.revoke_all" },
    meta: { revoked },
  });

  return apiSuccess({ revoked });
});
