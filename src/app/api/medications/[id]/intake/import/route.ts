import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp, safeJson } from "@/lib/api-response";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

const importEntrySchema = z.object({
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  uhrzeit: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  zaehler: z.union([z.number().int(), z.string()]).optional(),
});

const importSchema = z.array(importEntrySchema).min(1).max(1000);

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAuth();

  const { id } = await params;
  const medication = await prisma.medication.findUnique({ where: { id } });
  if (!medication || medication.userId !== user.id) {
    return apiError("Medikament nicht gefunden", 404);
  }

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;

  // Support both direct arrays and object-with-array payloads
  const payload = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null
      ? Object.values(body).find((value) => Array.isArray(value))
      : null;

  const parsed = importSchema.safeParse(payload);
  if (!parsed.success) {
    return apiError(
      `Ungültiges Format: ${parsed.error.issues[0].message}`,
      422,
    );
  }

  const entries = parsed.data;
  let imported = 0;
  let skippedDuplicates = 0;
  let skippedInvalid = 0;

  for (const entry of entries) {
    // Parse as local datetime first; if invalid, fall back to CET offset.
    let takenAt = new Date(`${entry.datum}T${entry.uhrzeit}`);
    if (isNaN(takenAt.getTime())) {
      takenAt = new Date(`${entry.datum}T${entry.uhrzeit}+01:00`);
    }
    if (isNaN(takenAt.getTime())) {
      skippedInvalid++;
      continue;
    }

    // Prefer explicit counter; otherwise use timestamp-based dedup key.
    const idempotencyKey = entry.zaehler
      ? `import-${id}-${String(entry.zaehler)}`
      : `import-${id}-${takenAt.getTime()}`;

    const existing = await prisma.medicationIntakeEvent.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      skippedDuplicates++;
      continue;
    }

    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: id,
        scheduledFor: takenAt,
        takenAt,
        skipped: false,
        source: "IMPORT",
        idempotencyKey,
      },
    });
    imported++;
  }

  await auditLog("medication.intake.import", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      medicationId: id,
      imported,
      skippedDuplicates,
      skippedInvalid,
      total: entries.length,
    },
  });

  annotate({
    action: {
      name: "medication.intake.import",
      entity_type: "medication",
      entity_id: id,
    },
    meta: { imported, skippedDuplicates, skippedInvalid, total: entries.length },
  });

  return apiSuccess({ imported, skippedDuplicates, skippedInvalid }, 201);
});
