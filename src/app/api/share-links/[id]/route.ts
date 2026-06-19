/**
 * DELETE /api/share-links/{id} — owner revokes one of their own share links.
 *
 * Revocation is a soft state change: it sets `revokedAt` (the scope columns
 * stay frozen). A cross-user id, an unknown id, or an already-revoked link all
 * resolve to 404 — the existence channel is sealed against probing another
 * user's ids. `userId` is narrowed from `requireAuth`; the update `where`
 * always pins both `id` AND `userId`.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";

export const DELETE = apiHandler(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { user } = await requireAuth();
    const { id } = await ctx.params;
    annotate({
      action: { name: "share-link.revoke" },
      meta: { shareLinkId: id },
    });

    const rl = await checkRateLimit(
      `share-link:${user.id}`,
      20,
      60 * 60 * 1000,
    );
    if (!rl.allowed) {
      return apiError("Maximum 20 share-link operations per hour", 429);
    }

    // Revoke only an own, not-yet-revoked link. The compound where pins the
    // owner so a cross-user id can never be touched; updateMany returns a
    // count so we can map "nothing matched" to a sealed 404.
    const result = await prisma.clinicianShareLink.updateMany({
      where: { id, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (result.count === 0) {
      return apiError("Share link not found", 404);
    }

    await auditLog("share-link.revoke", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { shareLinkId: id },
    });

    return apiSuccess({ id, revoked: true });
  },
);
