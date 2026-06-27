/**
 * DELETE /api/auth/me/sessions/[id] — revoke a single active web session.
 *
 * v1.23 — the deletion is scoped to the authenticated user (the Prisma `where`
 * narrows on both id AND userId), so a caller can never revoke another user's
 * session by guessing an id. A 404 is returned for a non-existent or
 * not-owned id so the surface cannot probe foreign session ids.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { destroySessionById } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export const DELETE = apiHandler(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { user, session } = await requireAuth();
    const { id } = await ctx.params;

    const removed = await destroySessionById(user.id, id);
    if (!removed) {
      return apiError("Session not found", 404);
    }

    await auditLog("auth.session.revoke", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { self: id === session.id },
    });

    annotate({
      action: { name: "auth.session.revoke" },
      meta: { self: id === session.id },
    });

    return apiSuccess({ revoked: true });
  },
);
