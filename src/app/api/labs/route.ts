import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { withIdempotency } from "@/lib/idempotency";
import { encryptNoteToBytes } from "@/lib/labs/store";
import { annotate } from "@/lib/logging/context";
import {
  classifyReferenceRange,
  createLabResultSchema,
  listLabResultsSchema,
} from "@/lib/validations/labs";

/**
 * v1.17.1 — structured lab-result store (`/api/labs`).
 *
 * GET lists the caller's live results with optional analyte / panel / date
 * filters. POST records a single reading. `userId` is always narrowed from
 * the session — never a body field — and the write `data` object is built
 * field-by-field (no mass assignment). The free-text note, when present, is
 * AES-256-GCM encrypted into the `noteEncrypted` Bytes column before write.
 */

// The serialised row never echoes the encrypted note bytes back; the badge
// status is computed server-side so the client renders a coherent, neutral
// in/out-of-range verdict without re-deriving the rule.
function serialiseLabResult(row: {
  id: string;
  panel: string | null;
  analyte: string;
  value: number;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  takenAt: Date;
  source: string;
  noteEncrypted: Uint8Array | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    panel: row.panel,
    analyte: row.analyte,
    value: row.value,
    unit: row.unit,
    referenceLow: row.referenceLow,
    referenceHigh: row.referenceHigh,
    takenAt: row.takenAt.toISOString(),
    source: row.source,
    hasNote: row.noteEncrypted !== null,
    rangeStatus: classifyReferenceRange(
      row.value,
      row.referenceLow,
      row.referenceHigh,
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listLabResultsSchema.safeParse(params);
  if (!parsed.success) {
    annotate({
      action: { name: "labs.list.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { analyte, panel, from, to, limit, offset, sortDir } = parsed.data;

  const where = {
    userId: user.id,
    deletedAt: null,
    ...(analyte && { analyte }),
    ...(panel && { panel }),
    ...(from || to
      ? {
          takenAt: {
            ...(from && { gte: from }),
            ...(to && { lte: to }),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.labResult.findMany({
      where,
      orderBy: { takenAt: sortDir },
      take: limit,
      skip: offset,
    }),
    prisma.labResult.count({ where }),
  ]);

  annotate({
    action: { name: "labs.list" },
    meta: { total, limit, offset },
  });

  return apiSuccess({
    results: rows.map(serialiseLabResult),
    meta: { total, limit, offset },
  });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postLabResult));

async function postLabResult(request: NextRequest) {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = createLabResultSchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "labs.create.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    // Free-text `analyte` / `unit` / `note` could land verbatim in a Zod
    // issue message — strip values from the audit-ledger breadcrumb.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "labs.create.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — the 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { panel, analyte, value, unit, referenceLow, referenceHigh, takenAt, note } =
    parsed.data;

  // Field-by-field assignment — never spread `parsed.data`. `source` is
  // hardcoded "MANUAL" for this user-facing path; import paths set their own.
  const created = await prisma.labResult.create({
    data: {
      userId: user.id,
      panel: panel ?? null,
      analyte,
      value,
      unit,
      referenceLow: referenceLow ?? null,
      referenceHigh: referenceHigh ?? null,
      takenAt,
      source: "MANUAL",
      noteEncrypted: note ? encryptNoteToBytes(note) : null,
    },
  });

  await auditLog("labResult.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { labResultId: created.id, analyte: created.analyte },
  });

  annotate({
    action: { name: "labs.create" },
    meta: { labResultId: created.id },
  });

  return apiSuccess(serialiseLabResult(created), 201);
}
