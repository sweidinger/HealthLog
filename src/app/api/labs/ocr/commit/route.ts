/**
 * v1.18.9 — POST /api/labs/ocr/commit
 *
 * Writes ONLY the rows the human confirmed on the review screen. Each row
 * resolves-or-mints a user-scoped biomarker by `(userId, lower(analyte))` —
 * exactly like the manual lab-write path — then creates a `LabResult` with
 * `source: "OCR"`. A row that now duplicates a live reading (re-checked at
 * commit time) is skipped rather than written. Idempotent (Idempotency-Key).
 *
 * `userId` is always narrowed from the session — never a body field. The write
 * `data` object is built field-by-field (no mass assignment).
 */
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
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";
import { serialiseLabResult } from "@/lib/labs/serialise";
import { annotate } from "@/lib/logging/context";
import {
  ocrCommitSchema,
  type OcrCommitRow,
  type OcrSkippedRowDto,
} from "@/lib/validations/labs-ocr";

export const POST = apiHandler(withIdempotency<[NextRequest]>(commitOcrRows));

/** True when a live reading already records this analyte+day+value. */
async function isDuplicate(
  userId: string,
  row: OcrCommitRow,
): Promise<boolean> {
  const dayStart = new Date(row.takenAt);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(row.takenAt);
  dayEnd.setUTCHours(23, 59, 59, 999);

  const candidates = await prisma.labResult.findMany({
    where: {
      userId,
      deletedAt: null,
      analyte: { equals: row.analyte.trim(), mode: "insensitive" },
      takenAt: { gte: dayStart, lte: dayEnd },
    },
    select: { value: true, valueText: true },
    take: 25,
  });
  for (const c of candidates) {
    if (row.value !== undefined && c.value !== null && c.value === row.value) {
      return true;
    }
    if (
      row.valueText !== undefined &&
      c.valueText !== null &&
      c.valueText.trim().toLowerCase() === row.valueText.trim().toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

async function commitOcrRows(request: NextRequest) {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 256 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = ocrCommitSchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "labs.ocr.commit.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    // Free-text analyte / unit could land in a Zod issue message — strip values.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "labs.ocr.commit.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {});
    return returnAllZodIssues(parsed.error, 422);
  }

  const inserted: ReturnType<typeof serialiseLabResult>[] = [];
  const skipped: OcrSkippedRowDto[] = [];

  for (const row of parsed.data.rows) {
    if (await isDuplicate(user.id, row)) {
      skipped.push({ analyte: row.analyte.trim(), reason: "duplicate" });
      continue;
    }

    const isQualitative = row.valueText !== undefined;
    const biomarker = await resolveOrMintBiomarker(user.id, {
      analyte: row.analyte,
      // A qualitative reading has no numeric unit / range.
      unit: isQualitative ? (row.unit ?? "") : (row.unit as string),
      referenceLow: isQualitative ? null : (row.referenceLow ?? null),
      referenceHigh: isQualitative ? null : (row.referenceHigh ?? null),
      panel: row.panel ?? null,
    });

    // Field-by-field — never spread the parsed row. The row stamps the resolved
    // catalog name/unit/range as historical truth and keeps the FK.
    const created = await prisma.labResult.create({
      data: {
        userId: user.id,
        biomarkerId: biomarker.id,
        panel: biomarker.panel,
        analyte: biomarker.name,
        value: row.value ?? null,
        valueText: row.valueText ?? null,
        unit: biomarker.unit,
        referenceLow: biomarker.lowerBound,
        referenceHigh: biomarker.upperBound,
        takenAt: row.takenAt,
        source: "OCR",
        noteEncrypted: null,
      },
    });

    inserted.push(serialiseLabResult(created, biomarker));
  }

  await auditLog("labs.ocr.commit", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { count: inserted.length, skipped: skipped.length },
  });

  annotate({
    action: { name: "labs.ocr.committed" },
    meta: { inserted: inserted.length, skipped: skipped.length },
  });

  // A lab panel just landed — resolve any "annual blood panel" reminders now
  // rather than waiting on the cron. Fire-and-forget.
  if (inserted.length > 0) {
    void enqueueReminderSatisfy(user.id).catch(() => {});
  }

  return apiSuccess({ inserted, skipped });
}
