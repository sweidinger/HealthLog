/**
 * v1.16.5 — schedule-era management for the Zeitplan tab.
 *
 *   GET  /api/medications/[id]/schedule-revisions
 *     - lists the medication's archived schedule eras (newest first)
 *       plus `currentSince`, the instant the LIVE plan took over (the
 *       newest revision's `validUntil`, or `medication.createdAt` when
 *       no era has been archived yet).
 *
 *   POST /api/medications/[id]/schedule-revisions
 *     - appends a MANUAL era for pre-tracking history ("dosed at
 *       07:00/19:00 from March to June"). Validation: the era must end
 *       at or before the start of the live era and must not overlap
 *       any existing revision. The snapshot payload mirrors what the
 *       write-path archive mints (`FREQ=DAILY`, window pulled to the
 *       min/max of the times) so the era minter — ledger, compliance,
 *       cadence chips — reads it like any other revision.
 *
 * Auth: cookie-session or Bearer via requireAuth(); the medication is
 * verified to belong to the caller before any read or write. Deleting
 * a manual era lives in the `[revisionId]` sub-route.
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
import { scheduleRevisionCreateSchema } from "@/lib/validations/schedule-revision";
import {
  toRevisionPayloadEntry,
  type ScheduleRevisionEntry,
} from "@/lib/medications/scheduling/schedule-eras";
import { enqueueUserMedicationComplianceBackfill } from "@/lib/rollups/medication-compliance-rollups";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Display projection of one archived schedule row. Defensive parsing —
 * a malformed payload entry degrades to an empty summary instead of
 * throwing on a read path (mirrors `canonicalSchedulesFromRevision`).
 */
function summariseEntries(payload: unknown): Array<{
  timesOfDay: string[];
  label: string | null;
  dose: string | null;
  scheduleType: string;
}> {
  if (!Array.isArray(payload)) return [];
  return payload.map((raw) => {
    const e = (raw ?? {}) as Partial<ScheduleRevisionEntry>;
    return {
      timesOfDay: Array.isArray(e.timesOfDay)
        ? e.timesOfDay.filter((t): t is string => typeof t === "string")
        : [],
      label: typeof e.label === "string" ? e.label : null,
      dose: typeof e.dose === "string" ? e.dose : null,
      scheduleType: typeof e.scheduleType === "string" ? e.scheduleType : "SCHEDULED",
    };
  });
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const med = await prisma.medication.findUnique({
      where: { id },
      select: { createdAt: true },
    });
    if (!med) {
      return apiError("Medication not found", 404);
    }

    const revisions = await prisma.medicationScheduleRevision.findMany({
      where: { medicationId: id },
      orderBy: { validFrom: "desc" },
      select: {
        id: true,
        validFrom: true,
        validUntil: true,
        source: true,
        payload: true,
      },
    });

    // The live plan has been current since the newest archived era
    // ended; with no archive it has been current since creation.
    const currentSince =
      revisions.length > 0
        ? revisions.reduce(
            (latest, r) => (r.validUntil > latest ? r.validUntil : latest),
            revisions[0].validUntil,
          )
        : med.createdAt;

    annotate({
      action: {
        name: "medication.schedule_revisions.list",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { revision_count: revisions.length },
    });

    return apiSuccess({
      currentSince: currentSince.toISOString(),
      revisions: revisions.map((r) => ({
        id: r.id,
        validFrom: r.validFrom.toISOString(),
        validUntil: r.validUntil.toISOString(),
        source: r.source,
        entries: summariseEntries(r.payload),
      })),
    });
  },
);

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

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

    const parsed = scheduleRevisionCreateSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422);
    }

    const validFrom = new Date(parsed.data.validFrom);
    const validUntil = new Date(parsed.data.validUntil);

    // Sanity floor — a fat-fingered year ("0203") would otherwise mint
    // an era the timeline renders as antiquity.
    if (validFrom.getUTCFullYear() < 1900) {
      return apiError("validFrom must be a date after 1900", 422);
    }

    const existing = await prisma.medicationScheduleRevision.findMany({
      where: { medicationId: id },
      select: { validFrom: true, validUntil: true },
    });

    // "Before the current plan": the live era began at the newest
    // archived `validUntil`; with no archive the live plan has covered
    // everything since the medication was created (the era splitter
    // reads `[newest validUntil, ∞)` — or the whole range when no
    // revision exists), so a manual era must end at or before
    // `createdAt`. Allowing it to reach "now" would let the manual
    // snapshot swallow tracked live history and re-score compliance
    // against the wrong plan.
    const liveStart = existing.reduce(
      (latest, r) => (r.validUntil > latest ? r.validUntil : latest),
      new Date(0),
    );
    const liveBoundary = existing.length > 0 ? liveStart : med.createdAt;
    if (validUntil.getTime() > liveBoundary.getTime()) {
      return apiError(
        "A manual era must end before the current plan begins",
        422,
      );
    }

    // No overlap with any archived interval `[validFrom, validUntil)`.
    const overlaps = existing.some(
      (r) =>
        validFrom.getTime() < r.validUntil.getTime() &&
        validUntil.getTime() > r.validFrom.getTime(),
    );
    if (overlaps) {
      return apiError("The era overlaps an existing schedule era", 422);
    }

    // Snapshot entry shaped exactly like the write-path archive: daily
    // recurrence at the given times, window pulled to their min/max.
    const times = [...parsed.data.timesOfDay].sort((a, b) =>
      a.localeCompare(b),
    );
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

    const revision = await prisma.medicationScheduleRevision.create({
      data: {
        medicationId: id,
        validFrom,
        validUntil,
        source: "MANUAL",
        payload: [entry] as unknown as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        validFrom: true,
        validUntil: true,
        source: true,
        payload: true,
      },
    });

    await auditLog("medication.schedule_revision.created", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id, revisionId: revision.id },
    });

    annotate({
      action: {
        name: "medication.schedule_revision.manual_created",
        entity_type: "medication",
        entity_id: id,
      },
      meta: {
        revision_id: revision.id,
        era_days: Math.round(
          (validUntil.getTime() - validFrom.getTime()) / 86_400_000,
        ),
      },
    });

    // The new era re-segments history the compliance rollups already
    // pre-aggregated; refresh them asynchronously. Best-effort like
    // every other rollup write-hook.
    await enqueueUserMedicationComplianceBackfill(user.id);

    return apiSuccess(
      {
        id: revision.id,
        validFrom: revision.validFrom.toISOString(),
        validUntil: revision.validUntil.toISOString(),
        source: revision.source,
        entries: summariseEntries(revision.payload),
      },
      201,
    );
  },
);
