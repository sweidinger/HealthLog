/**
 * v1.16.5 — DELETE /api/medications/[id]/schedule-revisions/[revisionId]
 * v1.16.6 — PATCH  /api/medications/[id]/schedule-revisions/[revisionId]
 *
 * DELETE removes a MANUAL schedule era (one the owner appended through
 * the sibling POST, or a correction minted by PATCH). Write-path
 * archives (`source: "ARCHIVED"`) are immutable history — the
 * wholesale-replace path minted them from rows that actually existed,
 * so deleting one would falsify the ledger; the route refuses with 409.
 * Deleting a correction restores the archived original it superseded.
 *
 * PATCH corrects an era. A MANUAL era updates in place. An ARCHIVED era
 * stays untouched as the audit record: the correction is minted as a
 * new MANUAL revision and the original's `supersededByRevisionId`
 * points at it, so every era consumer reads the correction while the
 * recorded history remains inspectable. Validation mirrors the sibling
 * POST (bounds order, live-plan ceiling, no overlap with other active
 * eras); the check-then-write runs under a `FOR UPDATE` lock on the
 * medication row so concurrent era writes serialise.
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
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { scheduleRevisionUpdateSchema } from "@/lib/validations/schedule-revision";
import { toRevisionPayloadEntry } from "@/lib/medications/scheduling/schedule-eras";
import { enqueueUserMedicationComplianceBackfill } from "@/lib/rollups/medication-compliance-rollups";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string; revisionId: string }> };

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id, revisionId } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const med = await prisma.medication.findUnique({
      where: { id },
      select: { createdAt: true },
    });
    if (!med) {
      return apiError("Medication not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = scheduleRevisionUpdateSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422);
    }

    const validFrom = new Date(parsed.data.validFrom);
    const validUntil = new Date(parsed.data.validUntil);

    // Sanity floor — mirrors the sibling POST.
    if (validFrom.getUTCFullYear() < 1900) {
      return apiError("validFrom must be a date after 1900", 422);
    }

    // Corrected snapshot, shaped exactly like the POST path: daily
    // recurrence at the (schema-deduped, sorted) times, window pulled
    // to their min/max.
    const times = parsed.data.timesOfDay;
    const entry = toRevisionPayloadEntry({
      timesOfDay: times,
      windowStart: times[0],
      windowEnd: times[times.length - 1],
      daysOfWeek: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      scheduleType: "SCHEDULED",
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
      doseWindows: null,
      label: null,
      dose: null,
      reminderGraceMinutes: null,
    });

    // Validate-then-write under the per-medication row lock — the same
    // serialisation as the sibling POST, so a concurrent era write can
    // never slip an overlapping interval past the check.
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM medications
        WHERE id = ${id}
        FOR UPDATE
      `;

      const target = await tx.medicationScheduleRevision.findUnique({
        where: { id: revisionId },
        select: {
          id: true,
          medicationId: true,
          source: true,
          supersededByRevisionId: true,
          validUntil: true,
        },
      });
      if (!target || target.medicationId !== id) {
        return {
          ok: false as const,
          status: 404 as const,
          error: "Schedule revision not found",
        };
      }
      if (target.supersededByRevisionId !== null) {
        return {
          ok: false as const,
          status: 409 as const,
          error: "This era has already been corrected",
        };
      }

      const others = await tx.medicationScheduleRevision.findMany({
        where: {
          medicationId: id,
          supersededByRevisionId: null,
          id: { not: revisionId },
        },
        select: { validFrom: true, validUntil: true },
      });

      // Live-plan ceiling, mirroring the POST rule: the live era began
      // at the newest active `validUntil` (never earlier than
      // `createdAt`). The edited era's own recorded end counts — an
      // ARCHIVED era adjacent to the live plan may keep its boundary,
      // but no correction may extend into tracked live history.
      const liveBoundary = [
        target.validUntil,
        ...others.map((r) => r.validUntil),
      ].reduce((latest, v) => (v > latest ? v : latest), med.createdAt);
      if (validUntil.getTime() > liveBoundary.getTime()) {
        return {
          ok: false as const,
          status: 422 as const,
          error: "A corrected era must end before the current plan begins",
        };
      }

      // No overlap with any OTHER active interval `[validFrom,
      // validUntil)` — the corrected bounds may of course cover the
      // era's own previous interval.
      const overlaps = others.some(
        (r) =>
          validFrom.getTime() < r.validUntil.getTime() &&
          validUntil.getTime() > r.validFrom.getTime(),
      );
      if (overlaps) {
        return {
          ok: false as const,
          status: 422 as const,
          error: "The era overlaps an existing schedule era",
        };
      }

      const revisionSelect = {
        id: true,
        validFrom: true,
        validUntil: true,
        source: true,
      } as const;

      if (target.source === "MANUAL") {
        const revision = await tx.medicationScheduleRevision.update({
          where: { id: revisionId },
          data: {
            validFrom,
            validUntil,
            payload: [entry] as unknown as Prisma.InputJsonValue,
          },
          select: revisionSelect,
        });
        return { ok: true as const, revision, mode: "in_place" as const };
      }

      // ARCHIVED — immutable. Mint the correction as a MANUAL row and
      // park the original behind it as the audit record.
      const revision = await tx.medicationScheduleRevision.create({
        data: {
          medicationId: id,
          validFrom,
          validUntil,
          source: "MANUAL",
          payload: [entry] as unknown as Prisma.InputJsonValue,
        },
        select: revisionSelect,
      });
      await tx.medicationScheduleRevision.update({
        where: { id: revisionId },
        data: { supersededByRevisionId: revision.id },
      });
      return { ok: true as const, revision, mode: "supersede" as const };
    });

    if (!outcome.ok) {
      return apiError(outcome.error, outcome.status);
    }

    await auditLog("medication.schedule_revision.updated", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        revisionId,
        mode: outcome.mode,
        ...(outcome.mode === "supersede" && {
          correctionRevisionId: outcome.revision.id,
        }),
      },
    });

    annotate({
      action: {
        name:
          outcome.mode === "in_place"
            ? "medication.schedule_revision.manual_updated"
            : "medication.schedule_revision.archived_corrected",
        entity_type: "medication",
        entity_id: id,
      },
      meta: {
        revision_id: outcome.revision.id,
        ...(outcome.mode === "supersede" && {
          superseded_revision_id: revisionId,
        }),
      },
    });

    // The corrected era re-segments history; refresh the pre-aggregated
    // compliance rollups asynchronously (best-effort).
    // v1.16.9 — an era write re-segments the bands every cached payload
    // (list next-due, compliance cells, dashboard tally) was built on;
    // hard-evict so the next read reflects the new history immediately.
    invalidateUserMedications(user.id, { evict: true });
    await enqueueUserMedicationComplianceBackfill(user.id);

    return apiSuccess({
      id: outcome.revision.id,
      validFrom: outcome.revision.validFrom.toISOString(),
      validUntil: outcome.revision.validUntil.toISOString(),
      source: outcome.revision.source,
      entries: [
        {
          timesOfDay: times,
          label: null,
          dose: null,
          scheduleType: "SCHEDULED",
        },
      ],
    });
  },
);

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
      return apiError("Only manually added schedule eras can be deleted", 409);
    }

    // Deleting a correction restores the archived original it had
    // superseded — the audit record becomes the era again, atomically
    // with the delete.
    await prisma.$transaction([
      prisma.medicationScheduleRevision.delete({
        where: { id: revisionId },
      }),
      prisma.medicationScheduleRevision.updateMany({
        where: { medicationId: id, supersededByRevisionId: revisionId },
        data: { supersededByRevisionId: null },
      }),
    ]);

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
    // v1.16.9 — an era write re-segments the bands every cached payload
    // (list next-due, compliance cells, dashboard tally) was built on;
    // hard-evict so the next read reflects the new history immediately.
    invalidateUserMedications(user.id, { evict: true });
    await enqueueUserMedicationComplianceBackfill(user.id);

    return apiSuccess({ deleted: true });
  },
);
