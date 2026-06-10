/**
 * DELETE /api/admin/invites/{id} — revoke a registration invite.
 *
 * v1.15.20 — hard delete: an invite row carries no health data and no
 * plaintext secret, and the audit log already records mint + revoke, so
 * keeping a tombstone would only grow the table. Idempotent — deleting
 * an unknown id returns `{ deleted: false }` rather than 404 so a
 * double-tap in the admin UI never surfaces an error.
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

    const { count } = await prisma.inviteToken.deleteMany({ where: { id } });
    const deleted = count > 0;

    if (deleted) {
      await auditLog("admin.invite.deleted", {
        userId: user.id,
        ipAddress: getClientIp(req),
        details: { inviteId: id },
      });
    }

    annotate({
      action: { name: "admin.invite.deleted" },
      meta: { deleted },
    });

    return apiSuccess({ deleted });
  },
);
