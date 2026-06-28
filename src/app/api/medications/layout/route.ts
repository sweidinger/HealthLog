/**
 * GET / PUT / DELETE medications list presentation.
 *
 * GET returns the resolved presentation (view + manual order, defaults
 * merged in if the user hasn't customised yet). PUT updates it with
 * preserve-when-absent semantics — a view-only PUT keeps the stored
 * order and vice versa, matching the `heroVisible` contract on
 * `/api/dashboard/widgets`. DELETE resets to default.
 *
 * Mirrors the shape and semantics of `/api/insights/layout`; the blob
 * lives on its own `User` column (`medication_list_layout_json`) per
 * the per-surface-column convention.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  buildPayloadDiagnostic,
  safeJson,
  returnAllZodIssues,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma, toJson } from "@/lib/db";
import {
  resolveMedicationListLayout,
  serializeMedicationListLayout,
  DEFAULT_MEDICATION_LIST_LAYOUT,
  MEDICATION_LIST_VIEWS,
  MEDICATION_ORDER_ID_MAX_LENGTH,
  MEDICATION_ORDER_MAX_ENTRIES,
  type MedicationListLayout,
} from "@/lib/medication-list-layout";
import { Prisma } from "@/generated/prisma/client";
import { z } from "zod/v4";
import { invalidateUserMedicationListLayout } from "@/lib/cache/invalidate";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { redactForExcerpt } from "@/lib/observability/redact-payload";
import { shouldEmitAuditRow } from "@/lib/audit-dedup";
import type { NextRequest } from "next/server";

const layoutSchema = z.object({
  version: z.literal(1),
  // Both fields are optional so a client can PUT exactly the field it
  // changed; the handler merges the absent one from the stored blob
  // (preserve-when-absent, like `heroVisible` on the dashboard layout).
  view: z.enum(MEDICATION_LIST_VIEWS).optional(),
  // Medication ids are opaque here — display-only ordering, unknown /
  // deleted ids are ignored at apply time, so the schema bounds size
  // and shape but does not assert ownership.
  order: z
    .array(z.string().min(1).max(MEDICATION_ORDER_ID_MAX_LENGTH))
    .max(MEDICATION_ORDER_MAX_ENTRIES)
    .optional(),
});

async function buildMedicationListLayout(
  userId: string,
): Promise<MedicationListLayout> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { medicationListLayoutJson: true },
  });
  return resolveMedicationListLayout(row?.medicationListLayoutJson);
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // 5-minute TTL matches the dashboard-widgets / insights-layout
  // caches; the blob changes only on a view toggle or an order save,
  // which invalidates via `invalidateUserMedicationListLayout()`.
  const layout = await cached(
    caches.medicationListLayout as ServerCache<MedicationListLayout>,
    user.id,
    () => buildMedicationListLayout(user.id),
    annotate,
  );
  return apiSuccess(layout);
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = layoutSchema.safeParse(body);
  if (!parsed.success) {
    // Multi-issue 422 envelope matches the dashboard-widgets / insights
    // layout routes; the wide-event line carries the redacted payload
    // shape for operator debugging without leaking the raw body.
    const issues = sanitiseZodIssues(parsed.error.issues);
    const payloadDiagnostic = buildPayloadDiagnostic(redactForExcerpt(body));
    annotate({
      action: { name: "medication.layout.validation-failed" },
      meta: {
        issue_count: issues.length,
        ...payloadDiagnostic,
        zod_issues: issues,
      },
    });
    if (
      shouldEmitAuditRow(
        user.id,
        "medication.layout.validation-failed",
        Date.now(),
      )
    ) {
      // Best-effort breadcrumb — never block the 422 on a write miss.
      // `message` strips from the audit row so a Zod code that embeds
      // the offending value cannot leak through the audit surface.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "medication.layout.validation-failed",
            details: JSON.stringify({ issues: auditIssues }),
          },
        })
        .catch(() => {
          /* swallow — validation response is the contract, audit row is best-effort */
        });
    }
    return returnAllZodIssues(parsed.error, 422);
  }

  // Preserve-when-absent: a PUT carrying only `view` must not wipe the
  // stored manual order, and an order-only PUT must not reset the view.
  // One stored-blob read covers both fallbacks.
  let mergedView = parsed.data.view;
  let mergedOrder = parsed.data.order;
  if (mergedView === undefined || mergedOrder === undefined) {
    const existing = await buildMedicationListLayout(user.id);
    if (mergedView === undefined) mergedView = existing.view;
    if (mergedOrder === undefined) mergedOrder = existing.order;
  }
  const normalized = serializeMedicationListLayout({
    view: mergedView,
    order: mergedOrder,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { medicationListLayoutJson: toJson(normalized) },
  });

  annotate({
    action: { name: "medication.layout.update" },
    meta: { view: normalized.view, order_count: normalized.order.length },
  });

  invalidateUserMedicationListLayout(user.id);

  return apiSuccess(normalized);
});

export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();

  await prisma.user.update({
    where: { id: user.id },
    data: { medicationListLayoutJson: Prisma.JsonNull },
  });

  annotate({ action: { name: "medication.layout.reset" } });

  invalidateUserMedicationListLayout(user.id);

  return apiSuccess(DEFAULT_MEDICATION_LIST_LAYOUT);
});
