import { prisma } from "@/lib/db";
import { lookupIpLocation } from "@/lib/geo";

export async function auditLog(
  action: string,
  opts: {
    userId?: string | null;
    details?: Record<string, unknown>;
    ipAddress?: string | null;
  } = {},
) {
  const entry = await prisma.auditLog.create({
    data: {
      action,
      userId: opts.userId ?? null,
      details: opts.details ? JSON.stringify(opts.details) : null,
      ipAddress: opts.ipAddress ?? null,
    },
  });

  // Fire-and-forget: resolve IP location and update the entry (3s timeout)
  if (opts.ipAddress && action.startsWith("auth.")) {
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 3000),
    );

    Promise.race([lookupIpLocation(opts.ipAddress), timeout])
      .then((location) => {
        if (location) {
          return prisma.auditLog.update({
            where: { id: entry.id },
            data: { location },
          });
        }
      })
      .catch(() => {
        // Silently ignore geo lookup failures
      });
  }
}
