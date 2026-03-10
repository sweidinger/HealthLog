import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  filter: z.enum(["auth", "all"]).default("auth"),
});

export const dynamic = "force-dynamic";

/**
 * Admin endpoint: list all auth-related audit log entries across all users.
 * Supports filtering by action prefix and pagination.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();
  annotate({ action: { name: "admin.audit-log.list" } });

  const { searchParams } = new URL(request.url);
  const { limit, offset, filter } = paginationSchema.parse({
    limit: searchParams.get("limit") ?? undefined,
    offset: searchParams.get("offset") ?? undefined,
    filter: searchParams.get("filter") ?? undefined,
  });

  const where =
    filter === "auth" ? { action: { startsWith: "auth." } } : undefined;

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
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
        user: {
          select: { id: true, username: true },
        },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return apiSuccess({ entries, meta: { total, limit, offset } });
});
