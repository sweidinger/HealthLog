/**
 * POST /api/admin/users/[id]/force-logout — admin-only kill-switch.
 *
 * Deletes every active session for the target user. The next request
 * from any of their browser/native clients will see the cookie/bearer
 * rejected and bounce to /auth/login. API tokens are NOT touched here
 * (admins manage those from the API-Tokens section); this endpoint is
 * specifically for "I see this user's session active in audit-log,
 * boot them now".
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { NextRequest } from "next/server";

export const POST = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user: admin } = await requireAdmin();
    const { id } = await params;

    annotate({
      action: {
        name: "admin.users.force-logout",
        entity_type: "user",
        entity_id: id,
      },
    });

    // Mirror the UI gate at user-management-section.tsx:295 — admins
    // mid-action shouldn't bounce themselves to /auth/login. A
    // determined admin can revoke another admin (intentional today),
    // but the self-target case is always a footgun.
    if (admin.id === id) {
      await auditLog("admin.user.force-logout.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { targetUserId: id, reason: "self_target" },
      });
      return apiError("Cannot force-logout your own session", 422);
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true },
    });
    if (!target) return apiError("User not found", 404);

    // Hard-delete all sessions; the cascading cookie + bearer guards in
    // `requireAuth()` reject anything missing from this table.
    const result = await prisma.session.deleteMany({
      where: { userId: id },
    });

    await auditLog("admin.user.force-logout", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: { targetUserId: id, sessionsRevoked: result.count },
    });

    annotate({ meta: { sessions_revoked: result.count } });

    return apiSuccess({ sessionsRevoked: result.count });
  },
);
