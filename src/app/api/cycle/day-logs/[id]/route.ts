/**
 * `PATCH /api/cycle/day-logs/{id}` — edit a single day-log
 * (ios-contract §2.A).
 * `DELETE /api/cycle/day-logs/{id}` — soft-delete (ios-contract §2.F):
 *   set `deletedAt` + bump `syncVersion`, emit a tombstone on the next
 *   sync page. 204. Idempotent.
 *
 * Both are gated (`cycle.disabled` 403) and owner-scoped (a row owned by
 * another user 404s).
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { encrypt } from "@/lib/crypto";
import { cycleDayLogPatchSchema } from "@/lib/validations/cycle";
import { toCycleDayLogDTO, dayLogSymptomInclude } from "@/lib/cycle/dto";

type RouteParams = { params: Promise<{ id: string }> };

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireCycleEnabled(user.id, user.gender);
    if (!gate.enabled) return gate.response;

    const { id } = await params;

    const existing = await prisma.cycleDayLog.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Day-log not found", 404);
    }

    const { data: rawBody, error: jsonError } = await safeJson(request);
    if (jsonError) return jsonError;

    const parsed = cycleDayLogPatchSchema.safeParse(rawBody);
    if (!parsed.success) {
      annotate({
        action: { name: "cycle.day-log.patch.validation-failed" },
        meta: { issue_count: parsed.error.issues.length },
      });
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "cycle.day-log.invalid",
      });
    }

    const body = parsed.data;

    // Field-by-field update (no mass assignment). Every field is
    // optional; an omitted field is left untouched. `note` re-encrypts;
    // an explicit null clears it.
    await prisma.cycleDayLog.update({
      where: { id },
      data: {
        ...(body.flow !== undefined && { flow: body.flow }),
        ...(body.intermenstrualBleeding !== undefined && {
          intermenstrualBleeding: body.intermenstrualBleeding,
        }),
        ...(body.basalBodyTempC !== undefined && {
          basalBodyTempC: body.basalBodyTempC,
        }),
        ...(body.ovulationTest !== undefined && {
          ovulationTest: body.ovulationTest,
        }),
        ...(body.cervicalMucus !== undefined && {
          cervicalMucus: body.cervicalMucus,
        }),
        ...(body.sexualActivity !== undefined && {
          sexualActivity: body.sexualActivity,
        }),
        ...(body.protectedSex !== undefined && {
          protectedSex: body.protectedSex,
        }),
        ...(body.pregnancyTest !== undefined && {
          pregnancyTest: body.pregnancyTest,
        }),
        ...(body.progesteroneTest !== undefined && {
          progesteroneTest: body.progesteroneTest,
        }),
        ...(body.contraceptive !== undefined && {
          contraceptive: body.contraceptive,
        }),
        ...(body.note !== undefined && {
          notesEncrypted: body.note ? encrypt(body.note) : null,
        }),
        syncVersion: { increment: 1 },
      },
    });

    // Replace symptom links only when `symptoms` was supplied.
    if (body.symptoms !== undefined) {
      const keys = Array.from(new Set(body.symptoms.map((s) => s.key)));
      const symptoms =
        keys.length > 0
          ? await prisma.cycleSymptom.findMany({
              where: {
                key: { in: keys },
                isActive: true,
                OR: [{ userId: null }, { userId: user.id }],
              },
              select: { id: true },
            })
          : [];
      await prisma.cycleSymptomLink.deleteMany({ where: { dayLogId: id } });
      if (symptoms.length > 0) {
        await prisma.cycleSymptomLink.createMany({
          data: symptoms.map((s) => ({ dayLogId: id, symptomId: s.id })),
          skipDuplicates: true,
        });
      }
    }

    const row = await prisma.cycleDayLog.findUniqueOrThrow({
      where: { id },
      include: dayLogSymptomInclude,
    });

    await auditLog("cycle.day-log.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { dayLogId: id },
    });

    annotate({
      action: {
        name: "cycle.day-log.update",
        entity_type: "cycle_day_log",
        entity_id: id,
      },
    });

    return apiSuccess(toCycleDayLogDTO(row));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireCycleEnabled(user.id, user.gender);
    if (!gate.enabled) return gate.response;

    const { id } = await params;

    const existing = await prisma.cycleDayLog.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Day-log not found", 404);
    }

    // Soft-delete: leave the row in place so the `/api/sync/changes`
    // delta feed surfaces it as a tombstone. A re-delete re-bumps
    // `syncVersion` harmlessly (idempotent).
    await prisma.cycleDayLog.update({
      where: { id },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });

    await auditLog("cycle.day-log.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { dayLogId: id },
    });

    annotate({
      action: {
        name: "cycle.day-log.delete",
        entity_type: "cycle_day_log",
        entity_id: id,
      },
    });

    return new Response(null, { status: 204 });
  },
);
