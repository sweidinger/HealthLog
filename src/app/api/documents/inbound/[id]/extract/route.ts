/**
 * v1.25 — optional AI extraction on an already-STORED document.
 *
 * Extraction is no longer part of upload: a document is stored first
 * (provider-free), and THIS route is the explicit, user-triggered enhancement.
 * It carries the entire ingest gauntlet that upload used to run inline —
 * resolve provider → assertConsentForChain → rate-limit → reserveBudget →
 * runInboundExtraction → reconcileSpend → stage facts — but now against a row
 * that already exists. Absent a provider this 422s the ENHANCEMENT only; the
 * stored document is untouched and remains filed.
 *
 * Two modes, dispatched on content-type (mirroring the original upload):
 *   - VISION (no JSON body): decrypt the stored original, re-derive its MIME,
 *     and run the vision-capable provider over it.
 *   - TEXT (application/json, opt-in local OCR): `{ mode: "text", text }` — the
 *     browser OCR'd the document locally and posts only the text to structure.
 *
 * The document is UNTRUSTED (prompt-injection): the server never acts on an
 * instruction inside it. The staged facts land PENDING for the mandatory
 * review-then-confirm screen; nothing reaches the structured stores here.
 */
import { Buffer } from "node:buffer";

import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { assertConsentForChain } from "@/lib/ai/consent-guard";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  InboundExtractError,
  runInboundExtraction,
  type InboundExtractionResult,
} from "@/lib/documents/extract";
import {
  decryptDocumentFromBytes,
  encryptFactData,
  encryptFactProvenance,
  serialiseDocumentDetail,
} from "@/lib/documents/store";
import {
  resolveTextProvider,
  resolveVisionProvider,
} from "@/lib/labs/ocr-capability";
import { detectOcrMimeType } from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { inboundTextExtractSchema } from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** Inbound extractions are expensive (vision) / metered (text). 6/hour. */
const EXTRACT_LIMIT_PER_HOUR = 6;
const EXTRACT_WINDOW_MS = 60 * 60 * 1000;
const TEXT_BODY_MAX_BYTES = 512 * 1024;

/** A loaded, owner-scoped, still-extractable document row. */
type LoadedDocument = {
  id: string;
  kind: string;
  contentEncrypted: Uint8Array;
  mimeType: string;
  status: string;
};

/**
 * Replace the document's staged facts and flip it to EXTRACTED in one
 * transaction. Re-extraction is allowed (a STORED / FAILED / EXTRACTED row),
 * so any prior PENDING staging is cleared first; facts already APPROVED into
 * the structured stores are independent rows and are not touched here.
 */
async function stageExtraction(
  documentId: string,
  userId: string,
  result: InboundExtractionResult,
) {
  return prisma.$transaction(async (tx) => {
    await tx.extractedFact.deleteMany({ where: { documentId, userId } });
    await tx.inboundDocument.update({
      where: { id: documentId },
      data: {
        status: "EXTRACTED",
        providerType: result.providerType,
        reportDate: result.reportDate
          ? new Date(`${result.reportDate}T00:00:00.000Z`)
          : null,
        facts: {
          create: result.facts.map((f) => ({
            userId,
            factType: f.factType,
            status: "PENDING" as const,
            confidence: f.confidence,
            needsReview: f.needsReview,
            dataEncrypted: encryptFactData(f.data),
            provenanceEncrypted: encryptFactProvenance(f.provenance),
          })),
        },
      },
    });
    return tx.inboundDocument.findUniqueOrThrow({
      where: { id: documentId },
      include: { facts: { orderBy: { createdAt: "asc" } } },
    });
  });
}

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const document = await prisma.inboundDocument.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      select: {
        id: true,
        kind: true,
        contentEncrypted: true,
        mimeType: true,
        status: true,
      },
    });
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }
    if (document.status === "CONFIRMED") {
      return apiError("This document has already been confirmed.", 422, {
        errorCode: "documents.inbound.alreadyConfirmed",
      });
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return handleTextExtract(request, user.id, document);
    }
    return handleVisionExtract(request, user.id, document);
  },
);

/** TEXT mode — structure in-browser-OCR'd text against the stored row. */
async function handleTextExtract(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
): Promise<Response> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { labsLocalOcrEnabled: true },
  });
  if (!row?.labsLocalOcrEnabled) {
    annotate({ action: { name: "documents.inbound.providerUnsupported" } });
    return apiError("Local OCR is not enabled", 422, {
      errorCode: "documents.inbound.localOcrDisabled",
    });
  }

  const { chain, pick } = await resolveTextProvider(userId);
  if (!pick) {
    return apiError("No AI provider is configured", 422, {
      errorCode: "documents.inbound.providerUnsupported",
    });
  }

  await assertConsentForChain({ userId, chain, surface: "insights" });

  const rl = await checkRateLimit(
    `documents-inbound:${userId}`,
    EXTRACT_LIMIT_PER_HOUR,
    EXTRACT_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many extractions. Try again later.", 429, {
      errorCode: "documents.inbound.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: TEXT_BODY_MAX_BYTES,
  });
  if (jsonError) return jsonError;

  const parsed = inboundTextExtractSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid document text payload", 422, {
      errorCode: "documents.inbound.extractFailed",
    });
  }

  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.ocrExtractText.maxTokens,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
  );
  if (!reservation.allowed) {
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "documents.inbound.budgetExceeded",
    });
  }

  try {
    const result = await runInboundExtraction({
      provider: pick.entry.instance,
      providerType: pick.providerType,
      ocrText: parsed.data.text,
    });
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
    );

    const updated = await stageExtraction(document.id, userId, result);

    await auditLog("documents.inbound.extract", {
      userId,
      ipAddress: getClientIp(request),
      details: {
        documentId: document.id,
        facts: updated.facts.length,
        mode: "text",
      },
    });

    return apiSuccess(serialiseDocumentDetail(updated, updated.facts));
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    if (err instanceof InboundExtractError) {
      return apiError("Couldn't read the document. Try a clearer copy.", 422, {
        errorCode: "documents.inbound.extractFailed",
      });
    }
    annotate({
      action: { name: "documents.inbound.extractFailed" },
      meta: { reason: "provider_error", mode: "text" },
    });
    return apiError("Couldn't read the document. Try a clearer copy.", 502, {
      errorCode: "documents.inbound.extractFailed",
    });
  }
}

/** VISION mode — run the stored original through the vision provider. */
async function handleVisionExtract(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
): Promise<Response> {
  const { chain, pick } = await resolveVisionProvider(userId);
  if (!pick) {
    return apiError("No vision-capable AI provider is configured", 422, {
      errorCode: "documents.inbound.providerUnsupported",
    });
  }

  await assertConsentForChain({ userId, chain, surface: "insights" });

  const rl = await checkRateLimit(
    `documents-inbound:${userId}`,
    EXTRACT_LIMIT_PER_HOUR,
    EXTRACT_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many extractions. Try again later.", 429, {
      errorCode: "documents.inbound.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  // Decrypt the stored original and re-derive its MIME from the bytes (never
  // trust a stored label for the provider call).
  let buffer: Buffer;
  try {
    buffer = decryptDocumentFromBytes(document.contentEncrypted);
  } catch {
    return apiError("Couldn't read the stored document.", 422, {
      errorCode: "documents.inbound.extractFailed",
    });
  }

  const mime = detectOcrMimeType(buffer);
  if (!mime) {
    return apiError(
      "This document can't be scanned. Use local OCR (text mode).",
      422,
      { errorCode: "documents.inbound.fileType" },
    );
  }

  if (mime === "application/pdf" && !pick.pdfSupported) {
    return apiError(
      "PDF scanning needs a Claude vision provider; use local OCR instead.",
      422,
      { errorCode: "documents.inbound.pdfNeedsAnthropic" },
    );
  }

  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.ocrExtract.maxTokens,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
  );
  if (!reservation.allowed) {
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "documents.inbound.budgetExceeded",
    });
  }

  const dataBase64 = buffer.toString("base64");
  const images =
    mime === "application/pdf" ? [] : [{ mediaType: mime, dataBase64 }];
  const documents =
    mime === "application/pdf"
      ? [{ mediaType: "application/pdf" as const, dataBase64 }]
      : [];

  try {
    const result = await runInboundExtraction({
      provider: pick.entry.instance,
      providerType: pick.providerType,
      images,
      documents,
    });
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
    );

    const updated = await stageExtraction(document.id, userId, result);

    await auditLog("documents.inbound.extract", {
      userId,
      ipAddress: getClientIp(request),
      details: {
        documentId: document.id,
        facts: updated.facts.length,
        mode: "vision",
      },
    });

    return apiSuccess(serialiseDocumentDetail(updated, updated.facts));
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    if (err instanceof InboundExtractError) {
      return apiError("Couldn't read the document. Try a clearer copy.", 422, {
        errorCode: "documents.inbound.extractFailed",
      });
    }
    annotate({
      action: { name: "documents.inbound.extractFailed" },
      meta: { reason: "provider_error", mode: "vision" },
    });
    return apiError("Couldn't read the document. Try a clearer copy.", 502, {
      errorCode: "documents.inbound.extractFailed",
    });
  }
}
