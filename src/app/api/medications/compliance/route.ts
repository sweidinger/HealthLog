import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  buildCompliancePayload,
  complianceCacheKey,
  type CompliancePayload,
} from "@/lib/medications/compliance-payload";
import {
  cachedSwr,
  caches,
  type ServerCache,
} from "@/lib/cache/server-cache";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * Batched card-compliance read: one round trip for every medication the
 * caller owns, replacing the per-card fan-out over
 * `GET /api/medications/{id}/compliance` (one request per card, ~1 s
 * cold each). The per-medication payload still builds and caches through
 * the SAME `medicationCompliance` cells the per-id route reads, so this
 * read warms the detail page (and vice versa) and both invalidate
 * together on a write.
 *
 * The heavy `dailyCompliance` heatmap map is intentionally NOT on this
 * wire shape — the cards render rates / streak / display block only; the
 * detail page keeps the per-id route for the grid.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `medication-compliance-summary:${user.id}`,
    30,
    60_000,
  );
  if (!rl.allowed) {
    return apiError("Too many compliance requests. Please retry later.", 429);
  }

  const userTz = user.timezone || "Europe/Berlin";

  // Same ordering as the medications list so the page's card order and
  // this payload walk the same sequence.
  const medications = await prisma.medication.findMany({
    where: { userId: user.id },
    include: {
      schedules: true,
      // v1.16.3 — archived schedule eras for era-aware compliance.
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Sequential on purpose: each cold cell costs one bounded intake read +
  // one band-expansion pass, and a sequential walk keeps a many-meds
  // account from stampeding the pool. Warm / stale cells return without
  // touching the database at all.
  const items = [];
  for (const medication of medications) {
    const payload = await cachedSwr(
      caches.medicationCompliance as ServerCache<CompliancePayload>,
      complianceCacheKey(user.id, medication.id, userTz),
      () => buildCompliancePayload(medication, user.id, userTz),
      annotate,
    );
    items.push({
      medicationId: medication.id,
      compliance7: payload.compliance7,
      compliance30: payload.compliance30,
      complianceDisplay: payload.complianceDisplay,
    });
  }

  annotate({
    action: { name: "medication.compliance_summary.read" },
    meta: { count: items.length },
  });

  return apiSuccess(items);
});
