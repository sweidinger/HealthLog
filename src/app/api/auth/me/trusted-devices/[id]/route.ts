/**
 * DELETE /api/auth/me/trusted-devices/[id]
 *
 * Revoke a single trusted device, scoped to the authenticated user (a foreign
 * id returns 404, never another user's row). When the revoked device is the
 * caller's own, the trusted-device cookie is cleared too. Cookie-only.
 */
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { revokeTrustedDevice } from "@/lib/auth/trusted-device";

export const dynamic = "force-dynamic";

export const DELETE = apiHandler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { user } = await requireCookieAuth();
    const { id } = await params;

    const revoked = await revokeTrustedDevice(user.id, id);
    if (!revoked) {
      annotate({ action: { name: "auth.trusted_device.revoke.not_found" } });
      return apiError("Trusted device not found", 404);
    }

    await auditLog("auth.trusted_device.revoke", {
      userId: user.id,
      ipAddress: getClientIp(req),
    });
    annotate({ action: { name: "auth.trusted_device.revoke" } });

    return apiSuccess({ revoked: true });
  },
);
