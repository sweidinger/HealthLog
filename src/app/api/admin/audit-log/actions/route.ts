import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

/**
 * Distinct list of `action` values currently present in the audit log,
 * sorted alphabetically. Powers the action-dropdown on the
 * `/admin/login-overview` filter UI so admins don't have to memorise the
 * action vocabulary (`auth.login`, `auth.bearer.failure`, `device.register.denied`,
 * etc.).
 *
 * `groupBy` is the cheapest way to get distinct values without sucking the
 * whole table into Node memory.
 */
export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.audit-log.actions" } });

  const grouped = await prisma.auditLog.groupBy({
    by: ["action"],
    orderBy: { action: "asc" },
  });

  return apiSuccess({
    actions: grouped.map((g) => g.action),
  });
});
