/**
 * v1.18.9 — Lab-OCR upload handling: bounded-body read + magic-byte MIME sniff.
 *
 * Mirrors the avatar route's hardened upload primitives (`/api/user/avatar`):
 * a single bounded stream read that aborts the moment the running total passes
 * the cap (so a chunked / unbounded upload cannot park past it), then a
 * magic-byte sniff because the wire Content-Type is operator-controlled. The
 * image sniff reuses `detectAvatarMimeType`; a PDF sniff is added here.
 *
 * The cap is larger than the avatar's 2 MiB — a lab photo or a multi-page PDF
 * is bigger. The uploaded bytes are held in memory only for the request's
 * lifetime (read → base64 → provider → discard); nothing is persisted.
 */
import { detectAvatarMimeType } from "@/lib/avatar";

/** Upload cap: 12 MiB covers a high-res photo or a short multi-page PDF. */
export const OCR_MAX_BYTES = 12 * 1024 * 1024;

/** The MIME types the extract route accepts (no HEIC in v1). */
export type OcrUploadMime =
  "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

/** Thrown by `readBoundedBody` when the stream exceeds the byte cap. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the configured byte cap");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a request body stream into a single buffer while counting bytes,
 * throwing `BodyTooLargeError` the moment the running total passes `maxBytes`.
 * Reads the body exactly once (no clone, no tee) so a cap trip frees the
 * allocation immediately. Keeps draining the stream to its natural close
 * rather than cancelling mid-transfer (an abrupt cancel races the undici
 * producer and surfaces as an unhandled rejection). Verbatim port of the
 * avatar route's reader.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (overflow) continue;
      if (retained + value.byteLength > maxBytes) {
        chunks.length = 0;
        retained = 0;
        overflow = true;
        continue;
      }
      chunks.push(value);
      retained += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (overflow) throw new BodyTooLargeError();
  const out = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Magic-byte MIME sniff for the OCR upload. Images defer to the avatar
 * sniffer; a PDF is recognised by the `%PDF-` header. Returns null for an
 * unsupported / unrecognised format.
 */
export function detectOcrMimeType(buffer: Buffer): OcrUploadMime | null {
  // PDF — "%PDF-" (25 50 44 46 2D).
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return "application/pdf";
  }
  return detectAvatarMimeType(buffer);
}
