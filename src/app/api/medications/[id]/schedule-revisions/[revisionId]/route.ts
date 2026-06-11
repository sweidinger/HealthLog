/**
 * v1.16.5 — DELETE /api/medications/[id]/schedule-revisions/[revisionId]
 *
 * Removes a MANUAL schedule era (one the owner appended through the
 * sibling POST). Write-path archives (`source: "ARCHIVED"`) are
 * immutable history — the wholesale-replace path minted them from rows
 * that actually existed, so deleting one would falsify the ledger; the
 * route refuses with 409.
 *
 * Auth: requireAuth() + medication ownership; a revision belonging to
 * another medication (or another user's medication) surfaces as 404,
 * existence channel sealed like every medication sub-route.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { enqueueUserMedicationComplianceBackfill } from "@/lib/rollups/medication-compliance-rollups";

type RouteParams = { params: Promise<{ id: string; revisionId: string }> };

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id, revisionId } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const revision = await prisma.medicationScheduleRevision.findUnique({
      where: { id: revisionId },
      select: { id: true, medicationId: true, source: true },
    });
    if (!revision || revision.medicationId !== id) {
      return apiError("Schedule revision not found", 404);
    }

    if (revision.source !== "MANUAL") {
      return apiError(
        "Only manually added schedule eras can be deleted",
        409,
      );
    }

    await prisma.medicationScheduleRevision.delete({
      where: { id: revisionId },
    });

    await auditLog("medication.schedule_revision.deleted", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id, revisionId },
    });

    annotate({
      action: {
        name: "medication.schedule_revision.manual_deleted",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { revision_id: revisionId },
    });

    // History re-segments without the era; refresh the pre-aggregated
    // compliance rollups asynchronously (best-effort).
    await enqueueUserMedicationComplianceBackfill(user.id);

    return apiSuccess({ deleted: true });
  },
);
