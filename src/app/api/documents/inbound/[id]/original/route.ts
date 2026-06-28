/**
 * v1.25.1 (W-DOCS-IN) — view / download the original uploaded document.
 *
 * The raw doctor report / discharge letter is stored encrypted at rest
 * (`InboundDocument.contentEncrypted`, AES-256-GCM). This route is the ONLY
 * path that decrypts and serves it, so the user can re-read the source the
 * extracted facts came from. Owner-scoped + module-gated; the bytes are PHI:
 * never logged, never served cross-user, fail-closed on a decrypt error.
 *
 * The response carries the stored `mimeType`. Uploads are constrained at the
 * store path to the inline-safe set (JPEG / PNG / WebP / PDF, magic-byte
 * sniffed), so the document is always served `Content-Disposition: inline` for
 * in-tab rendering. The filename is sanitised before it reaches the header.
 */
import { NextResponse } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { decryptDocumentFromBytes } from "@/lib/documents/store";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/**
 * Decrypting + serving an original is CPU work on PHI. A generous per-user
 * ceiling is a backstop against self-DoS only (the route is owner-scoped, so
 * there is no cross-user abuse vector).
 */
const ORIGINAL_READ_LIMIT_PER_HOUR = 240;
const ORIGINAL_READ_WINDOW_MS = 60 * 60 * 1000;

/** Extension fallback when the stored filename is absent / unusable. */
const MIME_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Percent-encode a UTF-8 string for an RFC 5987 `filename*` parameter. Builds
 * on `encodeURIComponent` and additionally escapes the characters it leaves but
 * RFC 5987's `attr-char` set forbids (`' ( ) *`).
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build a header-safe filename. Strips control characters (incl. CR/LF,
 * the header-injection vector), quotes, and path separators (path traversal),
 * caps the length, and falls back to a generated name keyed by the document
 * id + MIME type when nothing usable remains.
 */
function safeDownloadName(
  filename: string | null,
  id: string,
  mimeType: string,
): string {
  const ext = MIME_EXTENSION[mimeType] ?? "bin";
  const cleaned = (filename ?? "")
    // Strip control chars (incl. CR/LF — header injection), quotes, and path
    // separators (path traversal) before the value reaches the header.
    .replace(/[\u0000-\u001f"\\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : `document-${id}.${ext}`;
}

export const GET = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const rl = await checkRateLimit(
      `documents-original:${user.id}`,
      ORIGINAL_READ_LIMIT_PER_HOUR,
      ORIGINAL_READ_WINDOW_MS,
    );
    if (!rl.allowed) {
      const response = apiError("Too many requests. Try again later.", 429, {
        errorCode: "documents.inbound.rateLimited",
      });
      for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
        response.headers.set(k, v);
      }
      return response;
    }

    const { id } = await params;
    const document = await prisma.inboundDocument.findFirst({
      // Owner-scoped: the userId narrows the row so a cuid guess cannot reach
      // another user's document. A cookie session and a Bearer token both
      // resolve through requireAuth(); neither can cross the userId boundary.
      where: { id, userId: user.id, deletedAt: null },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        contentEncrypted: true,
      },
    });
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    let bytes: Buffer;
    try {
      bytes = decryptDocumentFromBytes(document.contentEncrypted);
    } catch {
      // Fail closed — never fall back to the raw ciphertext. The error reason
      // (bad / missing key id) is logged by the annotation, never the bytes.
      annotate({
        action: { name: "documents.inbound.original.decryptFailed" },
        meta: { documentId: document.id },
      });
      return apiError("Could not read the stored document", 500, {
        errorCode: "documents.inbound.decryptFailed",
      });
    }

    const downloadName = safeDownloadName(
      document.filename,
      document.id,
      document.mimeType,
    );
    // ASCII fallback for the bare `filename=` (replace any non-ASCII byte) plus
    // an RFC 5987 `filename*` that carries the real UTF-8 name to compliant
    // clients. The stored set is inline-safe by construction, so always inline.
    const asciiName = downloadName.replace(/[^ -~]/g, "_");
    const disposition = `inline; filename="${asciiName}"; filename*=UTF-8''${encodeRfc5987(downloadName)}`;

    annotate({
      action: { name: "documents.inbound.original.get" },
      meta: {
        documentId: document.id,
        mimeType: document.mimeType,
        bytes: bytes.byteLength,
        disposition: "inline",
      },
    });

    return new NextResponse(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": document.mimeType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": disposition,
        // Private PHI — never cache in a shared / disk cache.
        "Cache-Control": "private, no-store",
      },
    });
  },
);
