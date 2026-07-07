/**
 * v1.28 (document vault, Phase 3) — dependency-free metadata stripper for the
 * share egress boundary (P3-D4).
 *
 * A recipient of a shared document should not inadvertently receive the
 * owner's camera EXIF / GPS / XMP metadata. This module removes those markers
 * from the common camera-photo raster formats (JPEG, PNG, WebP) as the bytes
 * are served through the share route — NEVER at rest. The owner's stored
 * original is the artefact and is untouched (v1 §6.5): the strip is a pure
 * transform applied to a decrypted copy on its way out.
 *
 * Pure JS, no `sharp` / `libvips` / native decode (repo guardrail G6). We do
 * not decode or re-encode pixels: we walk the container's segment/chunk
 * structure and drop exactly the metadata carriers, copying every image-data
 * segment through verbatim. Output renders identically; only the metadata is
 * gone.
 *
 * Honest limits (documented in the operator docs + the share copy): PDF, TIFF,
 * HEIC/HEIF, and Office formats are out of this stripper's reach and pass
 * through unchanged. Those leave the origin as attachment-class downloads.
 * Any format we don't recognise — or any parse that runs off the end of the
 * buffer — is returned byte-for-byte unchanged (fail-safe: never corrupt a
 * document we can't confidently rewrite).
 */
import { Buffer } from "node:buffer";

/** MIME types this stripper actively rewrites. Everything else passes through. */
const STRIPPABLE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Strip EXIF/XMP/GPS metadata from a raster image's bytes, dispatched by the
 * document's stored (magic-byte-sniffed) MIME type. Returns the original
 * buffer unchanged for any non-strippable type, and — fail-safe — for any
 * input that does not parse cleanly as the claimed format.
 */
export function stripImageMetadata(bytes: Buffer, mimeType: string): Buffer {
  if (!STRIPPABLE_MIMES.has(mimeType)) return bytes;
  try {
    switch (mimeType) {
      case "image/jpeg":
        return stripJpeg(bytes);
      case "image/png":
        return stripPng(bytes);
      case "image/webp":
        return stripWebp(bytes);
      default:
        return bytes;
    }
  } catch {
    // Never corrupt a document because the stripper tripped: on any parse
    // error, serve the original bytes. The serving-class posture (nosniff +
    // true type) is the security boundary; the strip is a privacy nicety.
    return bytes;
  }
}

// ─── JPEG ────────────────────────────────────────────────────────────────────
//
// A JPEG is `FFD8` (SOI) followed by marker segments. Each non-entropy marker
// is `FF <marker> <len-hi> <len-lo> <payload…>` where `len` counts the two
// length bytes + payload. We drop the metadata-bearing APP segments and the
// comment segment, copy every other segment verbatim, and once we hit SOS
// (`FFDA`) copy the rest of the file (entropy-coded scan data) unchanged.
//
// Dropped: APP1 (`FFE1`, Exif + XMP), APP13 (`FFED`, Photoshop / IPTC), and
// COM (`FFFE`, free-text comment). Kept: APP0 (`FFE0`, JFIF — some decoders
// expect it) and APP2 (`FFE2`, ICC colour profile — dropping it would shift
// colours), plus every structural segment (quantisation/Huffman tables, frame
// headers, …).

const JPEG_DROP_MARKERS: ReadonlySet<number> = new Set([
  0xe1, // APP1 — Exif, XMP
  0xed, // APP13 — Photoshop / IPTC-IIM
  0xfe, // COM — comment
]);

function stripJpeg(bytes: Buffer): Buffer {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return bytes; // not a JPEG SOI — pass through
  }
  const out: Buffer[] = [bytes.subarray(0, 2)]; // SOI
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Misaligned — bail and keep the remainder verbatim (fail-safe).
      out.push(bytes.subarray(offset));
      return Buffer.concat(out);
    }
    const marker = bytes[offset + 1];
    // Start Of Scan: everything after is entropy-coded image data. Copy it all.
    if (marker === 0xda) {
      out.push(bytes.subarray(offset));
      return Buffer.concat(out);
    }
    // Standalone markers without a length payload (RSTn, TEM) — copy the 2
    // marker bytes and continue.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    // Length-prefixed segment.
    if (offset + 4 > bytes.length) {
      out.push(bytes.subarray(offset));
      return Buffer.concat(out);
    }
    const segLen = bytes.readUInt16BE(offset + 2);
    const segEnd = offset + 2 + segLen;
    if (segLen < 2 || segEnd > bytes.length) {
      // Corrupt length — keep the remainder verbatim rather than lose data.
      out.push(bytes.subarray(offset));
      return Buffer.concat(out);
    }
    if (!JPEG_DROP_MARKERS.has(marker)) {
      out.push(bytes.subarray(offset, segEnd));
    }
    offset = segEnd;
  }
  return Buffer.concat(out);
}

// ─── PNG ─────────────────────────────────────────────────────────────────────
//
// An 8-byte signature followed by `length(4 BE) type(4 ascii) data crc(4)`
// chunks. We drop the ancillary metadata chunks and copy everything else
// (IHDR, PLTE, IDAT, IEND, gAMA, cHRM, iCCP, sRGB, …) verbatim.
//
// Dropped: `eXIf` (EXIF), `tEXt` / `zTXt` / `iTXt` (text incl. XMP), `tIME`
// (last-modified timestamp).

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const PNG_DROP_CHUNKS: ReadonlySet<string> = new Set([
  "eXIf",
  "tEXt",
  "zTXt",
  "iTXt",
  "tIME",
]);

function stripPng(bytes: Buffer): Buffer {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return bytes;
  }
  const out: Buffer[] = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const dataLen = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + dataLen; // len + type + data + crc
    if (chunkEnd > bytes.length) {
      // Truncated chunk — keep the remainder verbatim (fail-safe).
      out.push(bytes.subarray(offset));
      return Buffer.concat(out);
    }
    if (!PNG_DROP_CHUNKS.has(type)) {
      out.push(bytes.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
    if (type === "IEND") break; // nothing legitimate follows IEND
  }
  return Buffer.concat(out);
}

// ─── WebP ────────────────────────────────────────────────────────────────────
//
// A RIFF container: `"RIFF" <size LE> "WEBP"` then FourCC chunks
// (`<fourcc(4)> <size LE(4)> <payload…>`, payload padded to an even length).
// We drop the `EXIF` and `XMP ` chunks and, when the extended header `VP8X` is
// present, clear its EXIF/XMP presence flag bits so the rewritten file is
// self-consistent. The image-data chunks (VP8/VP8L/VP8X/ALPH/ANIM/ANMF) copy
// through verbatim.

function stripWebp(bytes: Buffer): Buffer {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return bytes;
  }
  const kept: Buffer[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const padded = chunkSize + (chunkSize % 2); // chunks pad to even length
    const payloadStart = offset + 8;
    const chunkEnd = payloadStart + padded;
    if (chunkEnd > bytes.length) {
      // Truncated — keep the remainder verbatim (fail-safe).
      kept.push(bytes.subarray(offset));
      offset = bytes.length;
      break;
    }
    if (fourcc === "EXIF" || fourcc === "XMP ") {
      // Drop the metadata chunk entirely.
      offset = chunkEnd;
      continue;
    }
    if (fourcc === "VP8X") {
      // Extended-format header: byte 0 of the payload carries the feature
      // flags. Clear the EXIF (0x08) and XMP (0x04) presence bits so the
      // header no longer advertises metadata we just removed.
      const chunk = Buffer.from(bytes.subarray(offset, chunkEnd));
      chunk[8] = chunk[8] & ~0x08 & ~0x04;
      kept.push(chunk);
      offset = chunkEnd;
      continue;
    }
    kept.push(bytes.subarray(offset, chunkEnd));
    offset = chunkEnd;
  }
  // Rebuild the RIFF header with the recomputed payload size (the sum of the
  // kept chunks plus the trailing "WEBP" FourCC).
  const body = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4); // "WEBP" + chunk bytes
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, body]);
}
