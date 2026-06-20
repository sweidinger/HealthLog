import { Buffer } from "node:buffer";

import { describe, it, expect } from "vitest";

import { detectOcrMimeType, OCR_MAX_BYTES } from "../ocr-upload";

/** Pad a magic-byte header out to the 12-byte minimum the sniffer needs. */
function withMagic(bytes: number[]): Buffer {
  const buf = Buffer.alloc(16);
  buf.set(bytes, 0);
  return buf;
}

describe("detectOcrMimeType", () => {
  it("recognises a PDF by the %PDF- header", () => {
    expect(detectOcrMimeType(withMagic([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(
      "application/pdf",
    );
  });

  it("recognises a JPEG", () => {
    expect(detectOcrMimeType(withMagic([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
  });

  it("recognises a PNG", () => {
    expect(
      detectOcrMimeType(
        withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
  });

  it("recognises a WebP (RIFF....WEBP)", () => {
    const buf = Buffer.alloc(16);
    buf.write("RIFF", 0, "ascii");
    buf.write("WEBP", 8, "ascii");
    expect(detectOcrMimeType(buf)).toBe("image/webp");
  });

  it("returns null for an unrecognised / unsupported format", () => {
    expect(detectOcrMimeType(withMagic([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    // HEIC is deliberately NOT supported in v1.
    expect(detectOcrMimeType(Buffer.from("ftypheic", "ascii"))).toBeNull();
  });

  it("caps uploads at 12 MiB", () => {
    expect(OCR_MAX_BYTES).toBe(12 * 1024 * 1024);
  });
});
