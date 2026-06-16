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
import { withIdempotency } from "@/lib/idempotency";
import {
  type ResolvedBiomarker,
  serialiseLabResult,
} from "@/lib/labs/serialise";
import { encryptNoteToBytes } from "@/lib/labs/store";
import { annotate } from "@/lib/logging/context";
import {
  createLabResultSchema,
  listLabResultsSchema,
} from "@/lib/validations/labs";

/**
 * v1.17.1 — structured lab-result store (`/api/labs`).
 *
 * GET lists the caller's live results with optional biomarker / analyte /
 * panel / date filters. POST records a single reading. `userId` is always
 * narrowed from the session — never a body field — and the write `data`
 * object is built field-by-field (no mass assignment). The free-text note,
 * when present, is AES-256-GCM encrypted into the `noteEncrypted` Bytes
 * column before write.
 *
 * v1.18.1 — structured entry: when the body carries a `biomarkerId`, the row
 * links the user-scoped catalog marker and the response resolves its unit +
 * reference range FROM the biomarker (server-authoritative). The web + iOS
 * clients render the resolved DTO and never recompute.
 */

/** Map the joined biomarker (or null) into the resolver's shape. */
function toResolved(
  bm: {
    id: string;
    name: string;
    unit: string;
    lowerBound: number | null;
    upperBound: number | null;
    panel: string | null;
  } | null,
): ResolvedBiomarker | null {
  return bm ?? null;
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

  const { biomarkerId, analyte, panel, from, to, limit, offset, sortDir } =
    parsed.data;

  const where = {
    userId: user.id,
    deletedAt: null,
    ...(biomarkerId && { biomarkerId }),
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
      include: {
        biomarker: {
          select: {
            id: true,
            name: true,
            unit: true,
            lowerBound: true,
            upperBound: true,
            panel: true,
          },
        },
      },
    }),
    prisma.labResult.count({ where }),
  ]);

  annotate({
    action: { name: "labs.list" },
    meta: { total, limit, offset },
  });

  return apiSuccess({
    results: rows.map((row) =>
      serialiseLabResult(row, toResolved(row.biomarker)),
    ),
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

  const {
    biomarkerId,
    panel,
    analyte,
    value,
    unit,
    referenceLow,
    referenceHigh,
    takenAt,
    note,
  } = parsed.data;

  // Structured-entry path: resolve the catalog marker (and verify ownership)
  // so the row's name + unit derive from it. A forged / foreign id is a 404.
  let biomarker: ResolvedBiomarker | null = null;
  if (biomarkerId) {
    const found = await prisma.biomarker.findFirst({
      where: { id: biomarkerId, userId: user.id },
      select: {
        id: true,
        name: true,
        unit: true,
        lowerBound: true,
        upperBound: true,
        panel: true,
      },
    });
    if (!found) {
      return apiError("Biomarker not found", 404);
    }
    biomarker = found;
  }

  // Field-by-field assignment — never spread `parsed.data`. With a catalog
  // link the row stamps the resolved name/unit/range as historical truth
  // (so a later catalog edit does not silently rewrite a past reading) AND
  // keeps the FK; reads resolve the CURRENT catalog values via `serialise`.
  const created = await prisma.labResult.create({
    data: {
      userId: user.id,
      biomarkerId: biomarker?.id ?? null,
      panel: biomarker ? biomarker.panel : (panel ?? null),
      analyte: biomarker ? biomarker.name : (analyte as string),
      value,
      unit: biomarker ? biomarker.unit : (unit as string),
      referenceLow: biomarker ? biomarker.lowerBound : (referenceLow ?? null),
      referenceHigh: biomarker
        ? biomarker.upperBound
        : (referenceHigh ?? null),
      takenAt,
      source: "MANUAL",
      noteEncrypted: note ? encryptNoteToBytes(note) : null,
    },
  });

  await auditLog("labResult.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { labResultId: created.id },
  });

  annotate({
    action: { name: "labs.create" },
    meta: { labResultId: created.id, structured: biomarker !== null },
  });

  return apiSuccess(serialiseLabResult(created, biomarker), 201);
}
