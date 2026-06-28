/**
 * v1.25 (W-DOCS-IN) — inbound clinical documents: upload + list.
 *
 * POST ingests an uploaded doctor report / discharge letter through the
 * EXISTING dedicated OCR/vision provider rails (the v1.22 document-scan
 * provider), stores the raw document ENCRYPTED at rest, and stages the
 * extracted STRUCTURED FACTS for a mandatory review-then-confirm screen.
 * Nothing reaches the structured stores here — the confirm route is the only
 * write path, and a low-confidence fact fails closed.
 *
 * Two modes, dispatched on the request content-type (mirroring the Lab-OCR
 * extract route):
 *   - VISION (multipart/form-data): a photo / PDF run through the vision-capable
 *     provider; the original is stored encrypted.
 *   - TEXT (application/json, opt-in local OCR): the browser OCR's the image
 *     and POSTs only the extracted text; the text is stored encrypted (the raw
 *     image never reaches the server).
 *
 * Guards mirror the Lab-OCR discipline: requireAuth → module gate → resolve
 * provider → assertConsentForChain → rate-limit → reserveBudget → extract →
 * reconcile budget. The document is UNTRUSTED (prompt-injection): the server
 * never acts on an instruction inside it — the review step is the safety
 * boundary, and "extract, never interpret" is enforced end-to-end.
 */
import { Buffer } from "node:buffer";

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
  type StagedFactInput,
} from "@/lib/documents/extract";
import {
  encryptDocumentToBytes,
  encryptFactData,
  encryptFactProvenance,
  serialiseDocument,
} from "@/lib/documents/store";
import {
  resolveTextProvider,
  resolveVisionProvider,
} from "@/lib/labs/ocr-capability";
import {
  BodyTooLargeError,
  detectOcrMimeType,
  OCR_MAX_BYTES,
  readBoundedBody,
} from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  inboundTextExtractSchema,
  INBOUND_DOCUMENT_KINDS,
  type InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

/** Inbound extractions are expensive (vision) / metered (text). 6/hour. */
const EXTRACT_LIMIT_PER_HOUR = 6;
const EXTRACT_WINDOW_MS = 60 * 60 * 1000;
const TEXT_BODY_MAX_BYTES = 512 * 1024;

/** Persist the document + its staged facts and return the list DTO. */
async function persistExtraction(args: {
  userId: string;
  kind: InboundDocumentKindValue;
  filename: string | null;
  mimeType: string;
  byteSize: number;
  contentEncrypted: Uint8Array<ArrayBuffer>;
  providerType: string;
  reportDate: string | null;
  facts: StagedFactInput[];
}) {
  const document = await prisma.inboundDocument.create({
    data: {
      userId: args.userId,
      kind: args.kind,
      filename: args.filename,
      mimeType: args.mimeType,
      byteSize: args.byteSize,
      contentEncrypted: args.contentEncrypted,
      status: "EXTRACTED",
      providerType: args.providerType,
      reportDate: args.reportDate
        ? new Date(`${args.reportDate}T00:00:00.000Z`)
        : null,
      facts: {
        create: args.facts.map((f) => ({
          userId: args.userId,
          factType: f.factType,
          status: "PENDING" as const,
          confidence: f.confidence,
          needsReview: f.needsReview,
          dataEncrypted: encryptFactData(f.data),
          provenanceEncrypted: encryptFactProvenance(f.provenance),
        })),
      },
    },
    include: { facts: true },
  });
  return document;
}

export const POST = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();

  // Opt-in module gate — even a valid Bearer token is refused when the surface
  // is off (it ships dark; the user turns it on deliberately).
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return handleTextUpload(request, user.id);
  }
  return handleVisionUpload(request, user.id);
});

/** TEXT mode — structure in-browser-OCR'd text; store the text encrypted. */
async function handleTextUpload(
  request: Request,
  userId: string,
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
    const response = apiError("Too many uploads. Try again later.", 429, {
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

    const textBytes = Buffer.from(parsed.data.text, "utf8");
    const document = await persistExtraction({
      userId,
      kind: parsed.data.kind ?? result.kind,
      filename: null,
      mimeType: "text/plain",
      byteSize: textBytes.byteLength,
      contentEncrypted: encryptDocumentToBytes(textBytes),
      providerType: result.providerType,
      reportDate: result.reportDate,
      facts: result.facts,
    });

    await auditLog("documents.inbound.upload", {
      userId,
      ipAddress: getClientIp(request),
      details: {
        documentId: document.id,
        facts: document.facts.length,
        mode: "text",
      },
    });

    return apiSuccess(
      serialiseDocument(document, {
        factCount: document.facts.length,
        pendingCount: document.facts.length,
      }),
      201,
    );
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

/** VISION mode — run a photo / PDF through the vision provider; store it. */
async function handleVisionUpload(
  request: Request,
  userId: string,
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
    const response = apiError("Too many uploads. Try again later.", 429, {
      errorCode: "documents.inbound.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
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

  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > OCR_MAX_BYTES) {
      await reconcileSpend(userId, reservation.reserved, 0, dateKey);
      return apiError("File is too large (max 12 MB).", 413, {
        errorCode: "documents.inbound.fileTooLarge",
      });
    }

    let formData: FormData;
    try {
      const bytes = await readBoundedBody(request.body, OCR_MAX_BYTES);
      formData = await new Response(new Blob([bytes]), {
        headers: { "content-type": request.headers.get("content-type") ?? "" },
      }).formData();
    } catch (err) {
      await reconcileSpend(userId, reservation.reserved, 0, dateKey);
      if (err instanceof BodyTooLargeError) {
        return apiError("File is too large (max 12 MB).", 413, {
          errorCode: "documents.inbound.fileTooLarge",
        });
      }
      return apiError("Invalid multipart body", 400);
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      await reconcileSpend(userId, reservation.reserved, 0, dateKey);
      return apiError("Field 'file' must be a file", 422);
    }

    // Optional document-kind label (a label only; drives no interpretation).
    const kindRaw = formData.get("kind");
    const kind: InboundDocumentKindValue =
      typeof kindRaw === "string" &&
      (INBOUND_DOCUMENT_KINDS as readonly string[]).includes(kindRaw)
        ? (kindRaw as InboundDocumentKindValue)
        : "OTHER";

    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch {
      await reconcileSpend(userId, reservation.reserved, 0, dateKey);
      return apiError("Failed to read uploaded file", 400);
    }

    const mime = detectOcrMimeType(buffer);
    if (!mime) {
      await reconcileSpend(userId, reservation.reserved, 0, dateKey);
      return apiError("Upload a JPEG, PNG, WebP, or PDF.", 415, {
        errorCode: "documents.inbound.fileType",
      });
    }

    if (mime === "application/pdf" && !pick.pdfSupported) {
      await reconcileSpend(userId, reservation.reserved, 0, dateKey);
      return apiError(
        "PDF scanning needs a Claude vision provider; upload a photo instead.",
        422,
        { errorCode: "documents.inbound.pdfNeedsAnthropic" },
      );
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

      const document = await persistExtraction({
        userId,
        kind,
        filename:
          typeof file.name === "string" ? file.name.slice(0, 255) : null,
        mimeType: mime,
        byteSize: buffer.byteLength,
        contentEncrypted: encryptDocumentToBytes(buffer),
        providerType: result.providerType,
        reportDate: result.reportDate,
        facts: result.facts,
      });

      await auditLog("documents.inbound.upload", {
        userId,
        ipAddress: getClientIp(request),
        details: {
          documentId: document.id,
          facts: document.facts.length,
          mode: "vision",
        },
      });

      return apiSuccess(
        serialiseDocument(document, {
          factCount: document.facts.length,
          pendingCount: document.facts.length,
        }),
        201,
      );
    } catch (err) {
      await reconcileSpend(userId, reservation.reserved, 0, dateKey);
      if (err instanceof InboundExtractError) {
        return apiError(
          "Couldn't read the document. Try a clearer copy.",
          422,
          {
            errorCode: "documents.inbound.extractFailed",
          },
        );
      }
      annotate({
        action: { name: "documents.inbound.extractFailed" },
        meta: { reason: "provider_error", mode: "vision" },
      });
      return apiError("Couldn't read the document. Try a clearer copy.", 502, {
        errorCode: "documents.inbound.extractFailed",
      });
    }
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey).catch(
      () => {},
    );
    throw err;
  }
}

/** GET — list the caller's inbound documents (newest first, live only). */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const documents = await prisma.inboundDocument.findMany({
    where: { userId: user.id, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { facts: true } },
      facts: { where: { status: "PENDING" }, select: { id: true } },
    },
    take: 200,
  });

  annotate({
    action: { name: "documents.inbound.list" },
    meta: { count: documents.length },
  });

  return apiSuccess({
    documents: documents.map((doc) =>
      serialiseDocument(doc, {
        factCount: doc._count.facts,
        pendingCount: doc.facts.length,
      }),
    ),
  });
});
