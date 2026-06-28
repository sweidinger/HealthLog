/**
 * v1.25.1 (W-DOCS-IN) — view / download the original uploaded document.
 *
 * The raw doctor report / discharge letter is stored encrypted at rest
 * (`InboundDocument.contentEncrypted`, AES-256-GCM). This route is the ONLY
 * path that decrypts and serves it, so the user can re-read the source the
 * extracted facts came from. Owner-scoped + module-gated; the bytes are PHI:
 * never logged, never served cross-user, fail-closed on a decrypt error.
 *
 * The response carries the stored `mimeType`. A PDF / image is served inline
 * (`Content-Disposition: inline`) so the browser can render it in a tab; any
 * other type (e.g. the text-mode upload) is sent as an attachment. The
 * filename is sanitised before it reaches the header.
 */
import { NextResponse } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { decryptDocumentFromBytes } from "@/lib/documents/store";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** MIME types we render inline; everything else downloads as an attachment. */
const INLINE_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Extension fallback when the stored filename is absent / unusable. */
const MIME_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "text/plain": "txt",
};

/**
 * Build a header-safe ASCII filename. Strips control characters (incl. CR/LF,
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

    const inline = INLINE_MIME_TYPES.has(document.mimeType);
    const downloadName = safeDownloadName(
      document.filename,
      document.id,
      document.mimeType,
    );

    annotate({
      action: { name: "documents.inbound.original.get" },
      meta: {
        documentId: document.id,
        mimeType: document.mimeType,
        bytes: bytes.byteLength,
        disposition: inline ? "inline" : "attachment",
      },
    });

    return new NextResponse(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": document.mimeType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${downloadName}"`,
        // Private PHI — never cache in a shared / disk cache.
        "Cache-Control": "private, no-store",
      },
    });
  },
);
