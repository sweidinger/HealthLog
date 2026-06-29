import { prisma } from "@/lib/db";
import { lookupIpGeo } from "@/lib/geo";

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

  // Fire-and-forget: resolve IP location + carrier and update the entry
  // with whichever fields the resolver could fill. v1.25.8 — `lookupIpGeo`
  // unifies the online location + carrier lookup with the offline ASN MMDB
  // (carrier now resolves from the online provider when the optional offline
  // DB is absent). The whole resolve still races a 3 s timeout so a hung
  // provider can't stall the audit write.
  if (opts.ipAddress && action.startsWith("auth.")) {
    const ipAddress = opts.ipAddress;
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 3000),
    );

    Promise.race([lookupIpGeo(ipAddress), timeout])
      .then((result) => {
        if (!result) return;
        const { location, asn, carrier } = result;
        const data: {
          location?: string;
          asn?: number;
          carrier?: string | null;
        } = {};
        if (location) data.location = location;
        if (typeof asn === "number") data.asn = asn;
        if (carrier) data.carrier = carrier;
        if (Object.keys(data).length === 0) return;
        return prisma.auditLog.update({
          where: { id: entry.id },
          data,
        });
      })
      .catch(() => {
        // Silently ignore geo lookup failures
      });
  }
}
