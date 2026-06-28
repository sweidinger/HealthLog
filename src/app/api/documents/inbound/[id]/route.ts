/**
 * v1.25 — inbound clinical document by id: detail + metadata edit + discard.
 *
 * GET returns the document plus its staged facts for the review screen.
 * PATCH renames / recategorises / sets the user filing date (no mass
 * assignment; `userId` from the session feeds the `where`).
 * DELETE soft-deletes (tombstone) and marks the document DISCARDED — facts
 * already approved into the structured stores are independent rows and stay.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { serialiseDocumentDetail } from "@/lib/documents/store";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { documentUpdateSchema } from "@/lib/validations/inbound-documents";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const document = await prisma.inboundDocument.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      include: { facts: { orderBy: { createdAt: "asc" } } },
    });
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    annotate({
      action: { name: "documents.inbound.get" },
      meta: { documentId: id, facts: document.facts.length },
    });

    return apiSuccess(serialiseDocumentDetail(document, document.facts));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;

    const { data: body, error: jsonError } = await safeJson(request);
    if (jsonError) return jsonError;

    const parsed = documentUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid document update", 422, {
        errorCode: "documents.inbound.invalidUpdate",
      });
    }

    const existing = await prisma.inboundDocument.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    // No mass assignment — each editable column is set explicitly only when
    // the client sent it. `userId` is never a body field.
    const data: Prisma.InboundDocumentUpdateInput = {};
    if (parsed.data.title !== undefined) data.title = parsed.data.title;
    if (parsed.data.kind !== undefined) data.kind = parsed.data.kind;
    if (parsed.data.documentDate !== undefined) {
      data.documentDate = parsed.data.documentDate
        ? new Date(`${parsed.data.documentDate}T00:00:00.000Z`)
        : null;
    }

    await prisma.inboundDocument.update({
      where: { id: existing.id },
      data,
    });

    const document = await prisma.inboundDocument.findFirstOrThrow({
      where: { id: existing.id },
      include: { facts: { orderBy: { createdAt: "asc" } } },
    });

    await auditLog("documents.inbound.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        documentId: existing.id,
        fields: Object.keys(data),
      },
    });

    annotate({
      action: { name: "documents.inbound.update" },
      meta: { documentId: existing.id, fields: Object.keys(data).join(",") },
    });

    return apiSuccess(serialiseDocumentDetail(document, document.facts));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const document = await prisma.inboundDocument.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    await prisma.inboundDocument.update({
      where: { id: document.id },
      data: { deletedAt: new Date(), status: "DISCARDED" },
    });

    await auditLog("documents.inbound.discard", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { documentId: document.id },
    });

    annotate({
      action: { name: "documents.inbound.discard" },
      meta: { documentId: document.id },
    });

    return apiSuccess({ id: document.id, discarded: true });
  },
);
