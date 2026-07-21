/**
 * Fork ADHS Stage C — delete a single titration dose-change step.
 *
 * The titration plan-builder writes future-dated `MedicationDoseChange` rows
 * via `POST /api/medications/[id]/glp1` (the existing create path). To let the
 * user fix a mis-entered step there has to be a way to remove one — the glp1
 * route only creates. This adds the missing DELETE, scoped to a single step id
 * that must belong to the addressed medication.
 *
 * Mirrors the glp1 route's guards: auth + `assertMedicationOwnership` (so the
 * 404 shape is identical), a 30/min rate-limit, an audit-log entry, and the
 * same medications-cache eviction a create does (a removed step shifts the
 * dose history the card/curve derive).
 *
 * Descriptive-only, like the rest of Stage A–C: this edits what the user
 * recorded of their prescribed plan; it never suggests or computes a dose.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string; changeId: string }> };

const DELETE_RATE_LIMIT = 30;
const DELETE_WINDOW_MS = 60_000;

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id, changeId } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const rl = await checkRateLimit(
      `medication-glp1:delete:${user.id}`,
      DELETE_RATE_LIMIT,
      DELETE_WINDOW_MS,
    );
    if (!rl.allowed) {
      return apiError("Too many requests", 429, {
        headers: rateLimitHeaders(rl),
      });
    }

    // The step must exist AND belong to the addressed medication — otherwise
    // 404 with the same shape ownership failures produce, so a cross-medication
    // id probe can't distinguish "missing" from "not yours".
    const existing = await prisma.medicationDoseChange.findUnique({
      where: { id: changeId },
      select: { id: true, medicationId: true },
    });
    if (!existing || existing.medicationId !== id) {
      return apiError("Dose change not found", 404);
    }

    await prisma.medicationDoseChange.delete({ where: { id: changeId } });

    await auditLog("medication.glp1.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        kind: "doseChange.delete",
        doseChangeId: changeId,
      },
    });

    annotate({
      action: {
        name: "medication.glp1.doseChange.delete",
        entity_type: "medication_dose_change",
        entity_id: changeId,
      },
      meta: { medication_id: id },
    });

    // A removed step shifts the daily-dose estimate the list payload's runway
    // derivation uses. Hard-evict so the card reflects it on the next read.
    invalidateUserMedications(user.id, { evict: true });

    return apiSuccess({ deleted: changeId });
  },
);
