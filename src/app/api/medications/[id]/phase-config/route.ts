import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { phaseConfigSchema } from "@/lib/validations/phase-config";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const medication = await prisma.medication.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!medication || medication.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

    const config = await prisma.reminderPhaseConfig.findUnique({
      where: { medicationId: id },
    });

    annotate({
      action: {
        name: "medication.phase_config.get",
        entity_type: "medication",
        entity_id: id,
      },
    });

    // Return config or defaults
    return apiSuccess(
      config ?? {
        greenValue: 60,
        greenMode: "MINUTES",
        yellowValue: 30,
        yellowMode: "MINUTES",
        orangeValue: 0,
        orangeMode: "MINUTES",
        redValue: 240,
        redMode: "MINUTES",
      },
    );
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const medication = await prisma.medication.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!medication || medication.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request);

    if (jsonError) return jsonError;
    const parsed = phaseConfigSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid input", 400);
    }

    const config = await prisma.reminderPhaseConfig.upsert({
      where: { medicationId: id },
      create: {
        medicationId: id,
        ...parsed.data,
      },
      update: parsed.data,
    });

    annotate({
      action: {
        name: "medication.phase_config.update",
        entity_type: "medication",
        entity_id: id,
      },
    });

    return apiSuccess(config);
  },
);

export const DELETE = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const medication = await prisma.medication.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!medication || medication.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

    await prisma.reminderPhaseConfig.deleteMany({
      where: { medicationId: id },
    });

    annotate({
      action: {
        name: "medication.phase_config.reset",
        entity_type: "medication",
        entity_id: id,
      },
    });

    return apiSuccess({ reset: true });
  },
);
