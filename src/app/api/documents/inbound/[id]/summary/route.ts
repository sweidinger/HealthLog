/**
 * v1.27.22 (Document vault P2) — on-demand, SESSION-ONLY document summary /
 * extracted text.
 *
 * `?mode=summary` (default) returns a short plain-language summary of WHAT the
 * document is; `?mode=text` returns its raw transcribed text. Both are transient
 * (P2-D4): the result is returned once and NOTHING is persisted except the
 * AI-budget ledger and the audit log — never coach memory, snapshots, the
 * structured stores, or the search index. The summary is descriptive only and
 * is forbidden from diagnosing (interpretation boundary G7).
 *
 * Same VISION/TEXT dispatch and gauntlet as the extract route. The document is
 * UNTRUSTED (prompt-injection): the server never acts on an instruction inside
 * it. With no provider configured this 422s; nothing is stored either way.
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
import { assertDocumentEgressConsent } from "@/lib/ai/consent-guard";
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
import {
  DocumentDescribeError,
  runDocumentSummary,
  transcribeDocument,
  type DescribeInput,
} from "@/lib/documents/describe";
import {
  resolveDocumentTextProvider,
  resolveDocumentVisionProvider,
} from "@/lib/documents/provider-order";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  DOCUMENT_SUMMARY_MODES,
  inboundTextExtractSchema,
  type DocumentSummaryMode,
} from "@/lib/validations/inbound-documents";

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

function resolveMode(request: NextRequest): DocumentSummaryMode {
  const raw = new URL(request.url).searchParams.get("mode");
  return (DOCUMENT_SUMMARY_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as DocumentSummaryMode)
    : "summary";
}

/** Run the requested describe call (summary or raw text) over the input. */
async function describe(
  mode: DocumentSummaryMode,
  input: DescribeInput,
): Promise<{ summary: string } | { text: string }> {
  return mode === "text"
    ? transcribeDocument(input)
    : runDocumentSummary(input);
}

/** The budget the requested mode charges. */
function budgetFor(mode: DocumentSummaryMode): number {
  return mode === "text"
    ? AI_BUDGETS.documentTranscribe.maxTokens
    : AI_BUDGETS.documentSummary.maxTokens;
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

    const mode = resolveMode(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return handleTextSummary(request, user.id, document, mode);
    }
    return handleVisionSummary(request, user.id, document, mode);
  },
);

async function finishSummary(
  request: NextRequest,
  userId: string,
  documentId: string,
  inputMode: "vision" | "text",
  mode: DocumentSummaryMode,
  result: { summary: string } | { text: string },
): Promise<Response> {
  await auditLog("documents.inbound.summary", {
    userId,
    ipAddress: getClientIp(request),
    details: { documentId, mode, inputMode },
  });
  annotate({
    action: { name: "documents.summary.serve" },
    meta: { documentId, mode, inputMode },
  });
  return apiSuccess(result);
}

/** TEXT mode — summarise / echo in-browser-OCR'd text. */
async function handleTextSummary(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
  mode: DocumentSummaryMode,
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

  // `mode=text` over posted OCR text is a pure echo — the text IS the
  // transcription. No provider egress, no consent, no budget: session-only.
  if (mode === "text") {
    const result = await transcribeDocument({
      provider: {} as never,
      providerType: "local-ocr",
      ocrText: parsed.data.text,
    });
    return finishSummary(request, userId, document.id, "text", mode, result);
  }

  const { pick } = await resolveDocumentTextProvider(userId);
  if (!pick) {
    return apiError("No AI provider is configured", 422, {
      errorCode: "documents.inbound.providerUnsupported",
    });
  }
  await assertDocumentEgressConsent({
    userId,
    providerType: pick.providerType,
    surface: "insights",
  });

  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    budgetFor(mode),
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
  );
  if (!reservation.allowed) {
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "documents.inbound.budgetExceeded",
    });
  }

  try {
    const result = await describe(mode, {
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
    return finishSummary(request, userId, document.id, "text", mode, result);
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    return summaryError(err, "text");
  }
}

/** VISION mode — summarise / transcribe the stored original. */
async function handleVisionSummary(
  request: NextRequest,
  userId: string,
  document: LoadedDocument,
  mode: DocumentSummaryMode,
): Promise<Response> {
  const { pick } = await resolveDocumentVisionProvider(userId);
  if (!pick) {
    return apiError("No vision-capable AI provider is configured", 422, {
      errorCode: "documents.inbound.providerUnsupported",
    });
  }
  await assertDocumentEgressConsent({
    userId,
    providerType: pick.providerType,
    surface: "insights",
  });

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
    budgetFor(mode),
    dateKey,
    resolveDailyCap([{ providerType: pick.entry.providerType }]),
  );
  if (!reservation.allowed) {
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "documents.inbound.budgetExceeded",
    });
  }

  try {
    const result = await describe(mode, {
      provider: pick.entry.instance,
      providerType: pick.providerType,
      images: vision.images,
      documents: vision.documents,
    });
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
    );
    return finishSummary(request, userId, document.id, "vision", mode, result);
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey);
    return summaryError(err, "vision");
  }
}

function summaryError(err: unknown, mode: "vision" | "text"): Response {
  if (err instanceof DocumentDescribeError) {
    return apiError("Couldn't read the document. Try a clearer copy.", 422, {
      errorCode: "documents.inbound.extractFailed",
    });
  }
  annotate({
    action: { name: "documents.summary.failed" },
    meta: { reason: "provider_error", mode },
  });
  return apiError("Couldn't read the document. Try a clearer copy.", 502, {
    errorCode: "documents.inbound.extractFailed",
  });
}
