/**
 * v1.25 (W-DOCS-IN) — inbound clinical document by id: detail + discard.
 *
 * GET returns the document plus its staged facts for the review screen.
 * DELETE soft-deletes (tombstone) and marks the document DISCARDED — facts
 * already approved into the structured stores are independent rows and stay.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { serialiseDocumentDetail } from "@/lib/documents/store";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";

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
