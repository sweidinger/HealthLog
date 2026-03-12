import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp, safeJson } from "@/lib/api-response";
import { updateMeasurementSchema } from "@/lib/validations/measurement";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(async (_request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAuth();

  const { id } = await params;

  const measurement = await prisma.measurement.findUnique({
    where: { id },
  });

  if (!measurement || measurement.userId !== user.id) {
    return apiError("Measurement not found", 404);
  }

  annotate({
    action: {
      name: "measurement.get",
      entity_type: "measurement",
      entity_id: id,
    },
  });

  return apiSuccess(measurement);
});

export const PUT = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAuth();

  const { id } = await params;

  const existing = await prisma.measurement.findUnique({
    where: { id },
  });

  if (!existing || existing.userId !== user.id) {
    return apiError("Measurement not found", 404);
  }

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = updateMeasurementSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const data = parsed.data;
  const measurement = await prisma.measurement.update({
    where: { id },
    data: {
      ...(data.value !== undefined && { value: data.value }),
      ...(data.measuredAt !== undefined && { measuredAt: data.measuredAt }),
      ...(data.notes !== undefined && { notes: data.notes }),
    },
  });

  await auditLog("measurement.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { measurementId: id },
  });

  annotate({
    action: {
      name: "measurement.update",
      entity_type: "measurement",
      entity_id: id,
    },
  });

  return apiSuccess(measurement);
});

export const DELETE = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAuth();

  const { id } = await params;

  const existing = await prisma.measurement.findUnique({
    where: { id },
  });

  if (!existing || existing.userId !== user.id) {
    return apiError("Measurement not found", 404);
  }

  await prisma.measurement.delete({ where: { id } });

  await auditLog("measurement.delete", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { measurementId: id, type: existing.type },
  });

  annotate({
    action: {
      name: "measurement.delete",
      entity_type: "measurement",
      entity_id: id,
    },
  });

  return apiSuccess({ deleted: true });
});
