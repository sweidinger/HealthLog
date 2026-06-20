/**
 * v1.18.9 — POST /api/labs/ocr/extract
 *
 * Read-only (NOT idempotent) vision extraction of a paper lab report. Accepts
 * a multipart photo / PDF, runs it through the user's vision-capable AI
 * provider, and returns STRUCTURED proposed rows for the mandatory human
 * review screen. Nothing is written to the database here; the raw upload lives
 * in memory only and is never persisted or logged.
 *
 * Guards, in order (mirrors the Coach's discipline):
 *   requireAuth → resolve vision provider (422 if none) → assertConsentForChain
 *   → rate-limit (6/h) → reserveBudget → bounded body read → mime sniff →
 *   PDF/provider gate → runOcrExtraction → reconcile budget.
 *
 * The extracted text is UNTRUSTED (prompt-injection): the server never acts on
 * an instruction inside the document — the human review step is the safety
 * boundary, and the commit route is the only write path.
 */
import { Buffer } from "node:buffer";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { assertConsentForChain } from "@/lib/ai/consent-guard";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
} from "@/lib/ai/coach/budget";
import { resolveVisionProvider } from "@/lib/labs/ocr-capability";
import { OcrExtractError, runOcrExtraction } from "@/lib/labs/ocr-extract";
import {
  BodyTooLargeError,
  detectOcrMimeType,
  OCR_MAX_BYTES,
  readBoundedBody,
} from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** 6 vision calls per hour — they are expensive. */
const EXTRACT_LIMIT_PER_HOUR = 6;
const EXTRACT_WINDOW_MS = 60 * 60 * 1000;

export const POST = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();

  // 1. Resolve a vision-capable provider. 422 when none is configured.
  const { chain, pick } = await resolveVisionProvider(user.id);
  if (!pick) {
    annotate({
      action: { name: "labs.ocr.providerUnsupported" },
      meta: { chainLength: chain.length },
    });
    return apiError("No vision-capable AI provider is configured", 422, {
      errorCode: "labs.ocr.providerUnsupported",
    });
  }

  // 2. Consent gate — server-managed egress of health data requires a receipt.
  await assertConsentForChain({ userId: user.id, chain, surface: "insights" });

  // 3. Rate-limit (vision calls are costly).
  const rl = await checkRateLimit(
    `labs-ocr:${user.id}`,
    EXTRACT_LIMIT_PER_HOUR,
    EXTRACT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({ action: { name: "labs.ocr.rateLimited" } });
    const response = apiError("Too many scans. Try again later.", 429, {
      errorCode: "labs.ocr.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  // 4. Reserve the day's budget BEFORE the provider call (atomic, TOCTOU-safe).
  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    user.id,
    AI_BUDGETS.ocrExtract.maxTokens,
    dateKey,
  );
  if (!reservation.allowed) {
    annotate({
      action: { name: "labs.ocr.budget.exceeded" },
      meta: { totalAfter: reservation.totalAfter },
    });
    return apiError("Your AI usage budget for today is reached.", 429, {
      errorCode: "labs.ocr.budgetExceeded",
    });
  }

  // From here on a failure must refund the reservation.
  try {
    // 5. Pre-flight on the declared content length, then a stream-level
    // bounded read (a chunked upload omits Content-Length and would otherwise
    // buffer the whole body before any size check).
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > OCR_MAX_BYTES) {
      annotate({
        action: { name: "labs.ocr.fileRejected" },
        meta: { reason: "content_length_exceeded" },
      });
      await reconcileSpend(user.id, reservation.reserved, 0, dateKey);
      return apiError("File is too large (max 12 MB).", 413, {
        errorCode: "labs.ocr.fileTooLarge",
      });
    }

    let formData: FormData;
    try {
      const bytes = await readBoundedBody(request.body, OCR_MAX_BYTES);
      formData = await new Response(new Blob([bytes]), {
        headers: { "content-type": request.headers.get("content-type") ?? "" },
      }).formData();
    } catch (err) {
      await reconcileSpend(user.id, reservation.reserved, 0, dateKey);
      if (err instanceof BodyTooLargeError) {
        annotate({
          action: { name: "labs.ocr.fileRejected" },
          meta: { reason: "stream_size_exceeded" },
        });
        return apiError("File is too large (max 12 MB).", 413, {
          errorCode: "labs.ocr.fileTooLarge",
        });
      }
      return apiError("Invalid multipart body", 400);
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      await reconcileSpend(user.id, reservation.reserved, 0, dateKey);
      return apiError("Field 'file' must be a file", 422);
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
    } catch {
      await reconcileSpend(user.id, reservation.reserved, 0, dateKey);
      return apiError("Failed to read uploaded file", 400);
    }

    // 6. Magic-byte MIME sniff (the wire Content-Type is untrusted).
    const mime = detectOcrMimeType(buffer);
    if (!mime) {
      annotate({
        action: { name: "labs.ocr.fileRejected" },
        meta: { reason: "unsupported_mime" },
      });
      await reconcileSpend(user.id, reservation.reserved, 0, dateKey);
      return apiError("Upload a JPEG, PNG, WebP, or PDF.", 415, {
        errorCode: "labs.ocr.fileType",
      });
    }

    // 7. PDF gate — only Anthropic reads a native document block in v1.
    if (mime === "application/pdf" && !pick.pdfSupported) {
      annotate({
        action: { name: "labs.ocr.fileRejected" },
        meta: { reason: "pdf_provider_unsupported" },
      });
      await reconcileSpend(user.id, reservation.reserved, 0, dateKey);
      return apiError(
        "PDF scanning needs a Claude vision provider; upload a photo instead.",
        422,
        { errorCode: "labs.ocr.pdfNeedsAnthropic" },
      );
    }

    const dataBase64 = buffer.toString("base64");
    const images =
      mime === "application/pdf" ? [] : [{ mediaType: mime, dataBase64 }];
    const documents =
      mime === "application/pdf"
        ? [{ mediaType: "application/pdf" as const, dataBase64 }]
        : [];

    // 8. Run the extraction. The actual token spend reconciles the reservation.
    let actualTokens = 0;
    try {
      const result = await runOcrExtraction({
        userId: user.id,
        provider: pick.entry.instance,
        providerType: pick.providerType,
        images,
        documents,
      });
      // The orchestration does not surface token counts; reconcile against the
      // reserved estimate as the spend ceiling (the provider already billed it).
      actualTokens = reservation.reserved;
      await reconcileSpend(
        user.id,
        reservation.reserved,
        actualTokens,
        dateKey,
      );
      return apiSuccess(result);
    } catch (err) {
      // Provider/extraction failure — the call may still have burned tokens, so
      // reconcile against the reserved estimate rather than refunding in full.
      await reconcileSpend(
        user.id,
        reservation.reserved,
        actualTokens,
        dateKey,
      );
      if (err instanceof OcrExtractError) {
        return apiError("Couldn't read the report. Try a clearer photo.", 422, {
          errorCode: "labs.ocr.extractFailed",
        });
      }
      annotate({
        action: { name: "labs.ocr.extractFailed" },
        meta: { reason: "provider_error" },
      });
      return apiError("Couldn't read the report. Try a clearer photo.", 502, {
        errorCode: "labs.ocr.extractFailed",
      });
    }
  } catch (err) {
    // A guard threw after the reservation (e.g. consent races) — refund fully.
    await reconcileSpend(user.id, reservation.reserved, 0, dateKey).catch(
      () => {},
    );
    throw err;
  }
});
