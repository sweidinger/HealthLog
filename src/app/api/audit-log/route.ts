import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { NextRequest } from "next/server";

/**
 * Get audit log entries for the current user.
 * Query params: limit (default 50, max 200), offset (default 0)
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "audit-log.list" } });

  const { searchParams } = new URL(request.url);
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10) || 50),
    200,
  );
  const offset = Math.max(
    0,
    parseInt(searchParams.get("offset") ?? "0", 10) || 0,
  );

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        action: true,
        ipAddress: true,
        location: true,
        details: true,
        createdAt: true,
      },
    }),
    prisma.auditLog.count({
      where: { userId: user.id },
    }),
  ]);

  return apiSuccess({ entries, meta: { total, limit, offset } });
});
