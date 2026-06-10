/**
 * DELETE /api/admin/invites/{id} — revoke a registration invite.
 *
 * v1.16.0 — soft revocation (`revokedAt`), replacing the v1.15.20 hard
 * delete: the admin table now renders redemption history per invite,
 * and a deleted row would erase who was admitted through it. The
 * consume path refuses a revoked invite like an expired one.
 *
 * Idempotent — revoking an unknown or already-revoked id returns
 * `{ revoked: false }` rather than 404 so a double-tap in the admin UI
 * never surfaces an error.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";

export const dynamic = "force-dynamic";

export const DELETE = apiHandler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { user } = await requireAdmin();
    const { id } = await params;

    const { count } = await prisma.inviteToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const revoked = count > 0;

    if (revoked) {
      await auditLog("admin.invite.revoked", {
        userId: user.id,
        ipAddress: getClientIp(req),
        details: { inviteId: id },
      });
    }

    annotate({
      action: { name: "admin.invite.revoked" },
      meta: { revoked },
    });

    return apiSuccess({ revoked });
  },
);
