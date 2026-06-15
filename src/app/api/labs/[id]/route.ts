import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { decryptNoteFromBytes, encryptNoteToBytes } from "@/lib/labs/store";
import { annotate } from "@/lib/logging/context";
import {
  classifyReferenceRange,
  updateLabResultSchema,
} from "@/lib/validations/labs";

/**
 * v1.17.1 — single lab-result resource (`/api/labs/{id}`).
 *
 * GET returns the row including its decrypted note (the detail view is the
 * one place the plaintext note surfaces). PUT applies a partial edit
 * (`data` built field-by-field; an explicit `null` clears `panel` / `note` /
 * a reference bound, an omitted key leaves it untouched). DELETE soft-deletes
 * by stamping `deletedAt`. Cross-user rows surface as 404 (existence sealed).
 */

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const row = await prisma.labResult.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row || row.userId !== user.id) {
      return apiError("Lab result not found", 404);
    }

    annotate({ action: { name: "labs.get" }, meta: { labResultId: id } });

    return apiSuccess({
      id: row.id,
      panel: row.panel,
      analyte: row.analyte,
      value: row.value,
      unit: row.unit,
      referenceLow: row.referenceLow,
      referenceHigh: row.referenceHigh,
      takenAt: row.takenAt.toISOString(),
      source: row.source,
      note: row.noteEncrypted
        ? decryptNoteFromBytes(row.noteEncrypted)
        : null,
      rangeStatus: classifyReferenceRange(
        row.value,
        row.referenceLow,
        row.referenceHigh,
      ),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const existing = await prisma.labResult.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Lab result not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = updateLabResultSchema.safeParse(body);
    if (!parsed.success) {
      annotate({
        action: { name: "labs.update.validation-failed" },
        meta: { issue_count: parsed.error.issues.length, labResultId: id },
      });
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "labs.update.validation-failed",
            details: JSON.stringify({ issues: auditIssues, labResultId: id }),
          },
        })
        .catch(() => {
          /* swallow — the 422 response is the contract */
        });
      return returnAllZodIssues(parsed.error, 422);
    }

    const d = parsed.data;

    // Build `data` field-by-field. `undefined` → leave the column untouched;
    // an explicit `null` on `panel` / `note` / a reference bound clears it.
    const data: Record<string, unknown> = {};
    if (d.panel !== undefined) data.panel = d.panel;
    if (d.analyte !== undefined) data.analyte = d.analyte;
    if (d.value !== undefined) data.value = d.value;
    if (d.unit !== undefined) data.unit = d.unit;
    if (d.referenceLow !== undefined) data.referenceLow = d.referenceLow;
    if (d.referenceHigh !== undefined) data.referenceHigh = d.referenceHigh;
    if (d.takenAt !== undefined) data.takenAt = d.takenAt;
    if (d.note !== undefined) {
      data.noteEncrypted = d.note ? encryptNoteToBytes(d.note) : null;
    }

    const updated = await prisma.labResult.update({ where: { id }, data });

    await auditLog("labResult.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { labResultId: id },
    });

    annotate({ action: { name: "labs.update" }, meta: { labResultId: id } });

    return apiSuccess({
      id: updated.id,
      panel: updated.panel,
      analyte: updated.analyte,
      value: updated.value,
      unit: updated.unit,
      referenceLow: updated.referenceLow,
      referenceHigh: updated.referenceHigh,
      takenAt: updated.takenAt.toISOString(),
      source: updated.source,
      hasNote: updated.noteEncrypted !== null,
      rangeStatus: classifyReferenceRange(
        updated.value,
        updated.referenceLow,
        updated.referenceHigh,
      ),
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const existing = await prisma.labResult.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Lab result not found", 404);
    }

    // Soft-delete: stamp `deletedAt`. Every read filters `deletedAt: null`,
    // so the row is invisible from here on. A re-delete is idempotent.
    await prisma.labResult.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await auditLog("labResult.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { labResultId: id, analyte: existing.analyte },
    });

    annotate({ action: { name: "labs.delete" }, meta: { labResultId: id } });

    return apiSuccess({ deleted: true });
  },
);
