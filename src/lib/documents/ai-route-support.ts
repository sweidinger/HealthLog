/**
 * v1.27.22 (Document vault P2) — shared plumbing for the optional AI actions on
 * a stored document (suggest / summary / index). Each of those routes runs the
 * same gauntlet the extract route pioneered — module gate → provider resolve →
 * consent → rate-limit → budget — and the same vision-input preparation
 * (decrypt the stored original, re-derive its MIME from the bytes, gate PDF on
 * the Anthropic path). This module centralises the parts that would otherwise be
 * copy-pasted across the three routes; the per-route budget + prompt stay local.
 */
import { Buffer } from "node:buffer";

import { prisma } from "@/lib/db";
import { decryptDocumentContent } from "@/lib/documents/store";
import { detectOcrMimeType } from "@/lib/labs/ocr-upload";

/** The three AI actions share the extract route's 6/hour egress bucket. */
export const DOCUMENT_AI_LIMIT_PER_HOUR = 6;
export const DOCUMENT_AI_WINDOW_MS = 60 * 60 * 1000;
/** The shared rate-limit bucket key prefix (identical to the extract route). */
export const DOCUMENT_AI_BUCKET = "documents-inbound";
/** Cap on a browser-OCR text body (mirrors the extract text mode). */
export const DOCUMENT_AI_TEXT_BODY_MAX_BYTES = 512 * 1024;

/**
 * v1.27.33 (Document vault P4 — chat about a document) — the per-user request-
 * rate bucket for the document chat. Layered in front of the daily AI budget:
 * the budget catches the cost dimension, this catches the request-rate one (a
 * tight loop or a stolen session). 20 / minute mirrors the Coach chat bucket —
 * well outside any interactive use.
 */
export const DOCUMENT_CHAT_BUCKET = "document-chat";
export const DOCUMENT_CHAT_LIMIT_PER_MINUTE = 20;
export const DOCUMENT_CHAT_WINDOW_MS = 60 * 1000;

/** A loaded, owner-scoped, live document row with its encrypted content. */
export interface LoadedDocument {
  id: string;
  kind: string;
  contentEncrypted: Uint8Array;
  contentCodec: string;
  mimeType: string;
  status: string;
}

/** Load one live, owner-scoped document with the columns the AI actions need. */
export async function loadOwnedDocument(
  userId: string,
  id: string,
): Promise<LoadedDocument | null> {
  return prisma.inboundDocument.findFirst({
    where: { id, userId, deletedAt: null },
    select: {
      id: true,
      kind: true,
      contentEncrypted: true,
      contentCodec: true,
      mimeType: true,
      status: true,
    },
  });
}

/** The provider-ready vision payload derived from a stored document. */
export type VisionInput =
  | {
      ok: true;
      images: {
        mediaType: "image/jpeg" | "image/png" | "image/webp";
        dataBase64: string;
      }[];
      documents: { mediaType: "application/pdf"; dataBase64: string }[];
    }
  | { ok: false; reason: "decryptFailed" | "fileType" | "pdfNeedsAnthropic" };

/**
 * Decrypt the stored original, re-derive its MIME from the bytes (never trust
 * the stored label for a provider call), and split it into the images/documents
 * arrays a vision call takes. Fails closed on a decrypt error and rejects a PDF
 * on a provider that cannot read PDFs natively.
 */
export function prepareVisionInput(
  document: LoadedDocument,
  pdfSupported: boolean,
): VisionInput {
  let buffer: Buffer;
  try {
    buffer = decryptDocumentContent(
      document.contentEncrypted,
      document.contentCodec,
    );
  } catch {
    return { ok: false, reason: "decryptFailed" };
  }

  const mime = detectOcrMimeType(buffer);
  if (!mime) return { ok: false, reason: "fileType" };
  if (mime === "application/pdf" && !pdfSupported) {
    return { ok: false, reason: "pdfNeedsAnthropic" };
  }

  const dataBase64 = buffer.toString("base64");
  if (mime === "application/pdf") {
    return {
      ok: true,
      images: [],
      documents: [{ mediaType: "application/pdf", dataBase64 }],
    };
  }
  return { ok: true, images: [{ mediaType: mime, dataBase64 }], documents: [] };
}
