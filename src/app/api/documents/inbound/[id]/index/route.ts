/**
 * v1.27.22 (Document vault P2) — populate / refresh one document's content
 * search index.
 *
 * VISION (no JSON body): decrypt the stored original, run ONE provider
 * transcription call, then tokenise + encrypt the text into
 * `DocumentContentIndex`. Consent + budget gated, exactly like extract.
 *
 * TEXT (`application/json`, opt-in local OCR): `{ mode: "text", text }` — the
 * browser OCR'd the image on-device and posts only the TEXT (P2-D9). No provider
 * egress, so no consent / budget; the server just tokenises + encrypts it. The
 * raw image never leaves the device on this path.
 *
 * Decision (maintainer, 2026-07-07): content indexing is gated on the EXISTING
 * AI consent / provider gate — there is NO separate `documentsContentIndexEnabled`
 * toggle (the plan's P2-D8 opt-in was refused to avoid toggle sprawl). The vision
 * path runs `assertConsentForChain`; the text path rides the local-OCR opt-in the
 * lab / extract text mode already uses.
 *
 * Persists ONLY AES-256-GCM ciphertext text + opaque HMAC token hashes (A4).
 */
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
import {
  DOCUMENT_AI_BUCKET,
  DOCUMENT_AI_LIMIT_PER_HOUR,
  DOCUMENT_AI_TEXT_BODY_MAX_BYTES,
  DOCUMENT_AI_WINDOW_MS,
  loadOwnedDocument,
  prepareVisionInput,
  type LoadedDocument,
} from "@/lib/documents/ai-route-support";
import { upsertContentIndex } from "@/lib/documents/content-index";
import {
  DocumentDescribeError,
  transcribeDocument,
} from "@/lib/documents/describe";
import { resolveVisionProvider } from "@/lib/labs/ocr-capability";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { inboundTextExtractSchema } from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function rateLimited(rl: Awaited<ReturnType<typeof checkRateLimit>>): Response {
  const response = apiError("Too many requests. Try again later.", 429, {
    errorCode: "documents.inbound.rateLimited",
  });
  for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
    response.headers.set(k, v);
  }
  return response;
}

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const document = await loadOwnedDocument(user.id, id);
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return handleTextIndex(request, user.id, document);
    }
    return handleVisionIndex(request, user.id, document);
  },
);

async function finishIndex(
  request: NextRequest,
  userId: string,
  documentId: string,
  source: "vision" | "text-ocr",
  tokenCount: number,
): Promise<Response> {
  await auditLog("documents.inbound.index", {
    userId,
    ipAddress: getClientIp(request),
    details: { documentId, source, tokens: tokenCount },
  });
  annotate({
    action: { name: "documents.contentIndex.upsert" },
    meta: { documentId, source, tokens: tokenCount },
  });
  return apiSuccess({ documentId, indexed: true, tokenCount });
}

/** TEXT mode — index browser-OCR'd text (no provider egress). */
async function handleTextIndex(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
): Promise<Response> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { labsLocalOcrEnabled: true },
  });
  if (!row?.labsLocalOcrEnabled) {
    return apiError("Local OCR is not enabled", 422, {
      errorCode: "documents.inbound.localOcrDisabled",
    });
  }

  const rl = await checkRateLimit(
    `${DOCUMENT_AI_BUCKET}:${userId}`,
    DOCUMENT_AI_LIMIT_PER_HOUR,
    DOCUMENT_AI_WINDOW_MS,
  );
  if (!rl.allowed) return rateLimited(rl);

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: DOCUMENT_AI_TEXT_BODY_MAX_BYTES,
  });
  if (jsonError) return jsonError;
  const parsed = inboundTextExtractSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid document text payload", 422, {
      errorCode: "documents.inbound.extractFailed",
    });
  }

  const { tokenCount } = await upsertContentIndex({
    userId,
    documentId: document.id,
    text: parsed.data.text,
    source: "text-ocr",
    providerType: null,
  });
  return finishIndex(request, userId, document.id, "text-ocr", tokenCount);
}

/** VISION mode — transcribe the stored original, then index the text. */
async function handleVisionIndex(
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
    `${DOCUMENT_AI_BUCKET}:${userId}`,
    DOCUMENT_AI_LIMIT_PER_HOUR,
    DOCUMENT_AI_WINDOW_MS,
  );
  if (!rl.allowed) return rateLimited(rl);

  const vision = prepareVisionInput(document, pick.pdfSupported);
  if (!vision.ok) {
    if (vision.reason === "pdfNeedsAnthropic") {
      return apiError(
        "PDF scanning needs a Claude vision provider; use local OCR instead.",
        422,
        { errorCode: "documents.inbound.pdfNeedsAnthropic" },
      );
    }
    if (vision.reason === "fileType") {
      return apiError(
        "This document can't be scanned. Use local OCR (text mode).",
        422,
        { errorCode: "documents.inbound.fileType" },
      );
    }
    return apiError("Couldn't read the stored document.", 422, {
      errorCode: "documents.inbound.extractFailed",
    });
  }

  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.documentTranscribe.maxTokens,
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
  );
  if (!reservation.allowed) {
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "documents.inbound.budgetExceeded",
    });
  }

  try {
    const { text } = await transcribeDocument({
      provider: pick.entry.instance,
      providerType: pick.providerType,
      images: vision.images,
      documents: vision.documents,
    });
    await reconcileSpend(userId, reservation.reserved, reservation.reserved, dateKey);
    const { tokenCount } = await upsertContentIndex({
      userId,
      documentId: document.id,
      text,
      source: "vision",
      providerType: pick.providerType,
    });
    return finishIndex(request, userId, document.id, "vision", tokenCount);
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    if (err instanceof DocumentDescribeError) {
      return apiError("Couldn't read the document. Try a clearer copy.", 422, {
        errorCode: "documents.inbound.extractFailed",
      });
    }
    annotate({
      action: { name: "documents.contentIndex.failed" },
      meta: { reason: "provider_error", mode: "vision" },
    });
    return apiError("Couldn't read the document. Try a clearer copy.", 502, {
      errorCode: "documents.inbound.extractFailed",
    });
  }
}
