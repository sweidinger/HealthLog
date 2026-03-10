import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { destroyAllSessions } from "@/lib/auth/session";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

/**
 * Permanently delete the user account and ALL associated data.
 * Cascading deletes in the schema handle all related records.
 */
export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  let confirm = "";
  try {
    const body = await request.json();
    confirm = typeof body?.confirm === "string" ? body.confirm : "";
  } catch {
    return apiError("Ungueltige Anfrage", 422);
  }

  if (confirm !== "DELETE_ACCOUNT") {
    return apiError(
      "Bestaetigung fehlt. Sende { confirm: 'DELETE_ACCOUNT' }",
      422,
    );
  }

  // Prevent last admin from deleting themselves
  if (user.role === "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      return apiError(
        "Der letzte Admin-Account kann nicht geloescht werden",
        400,
      );
    }
  }

  const userId = user.id;
  const username = user.username;

  // Log before deletion (userId will be SetNull in audit_logs after cascade)
  await auditLog("user.account.delete", {
    userId,
    ipAddress: getClientIp(request),
    details: { username },
  });

  // Destroy all sessions first
  await destroyAllSessions(userId);

  // Delete user — all related data is removed via onDelete: Cascade
  await prisma.user.delete({ where: { id: userId } });

  annotate({
    action: { name: "settings.account.delete" },
    meta: { username },
  });

  return apiSuccess({ deleted: true });
});
