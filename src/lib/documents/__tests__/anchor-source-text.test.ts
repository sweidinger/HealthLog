/**
 * Provenance anchoring — the model's quote is a lookup key, never content.
 *
 * Both branches matter equally. A quote that IS in the document must come back
 * as the document's own characters (not the model's rendering of them), and a
 * quote that is NOT in the document must come back unanchored with no text at
 * all — never a paraphrase presented to a reviewer as a verbatim excerpt.
 */
import { describe, expect, it } from "vitest";

import { anchorSourceText } from "@/lib/documents/anchor-source-text";

const OCR = [
  "Befundbericht 2026-01-02",
  "Dx: Type 2 diabetes mellitus (E11.9)",
  "Hämoglobin    14.2 g/dL   (13.5-17.5)",
  "Metformin 500 mg twice daily",
].join("\n");

describe("anchorSourceText — located spans", () => {
  it("returns the document's own span for an exact echo", () => {
    const anchored = anchorSourceText(
      "Dx: Type 2 diabetes mellitus (E11.9)",
      OCR,
    );
    expect(anchored.anchored).toBe(true);
    expect(anchored.sourceText).toBe("Dx: Type 2 diabetes mellitus (E11.9)");
    expect(anchored.sourceOffset).toBe(OCR.indexOf("Dx:"));
  });

  it("stores the source spacing, not the model's normalised spacing", () => {
    // The model collapsed the OCR column padding to single spaces. The stored
    // span must be what the document carries, padding included.
    const anchored = anchorSourceText("Hämoglobin 14.2 g/dL (13.5-17.5)", OCR);
    expect(anchored.anchored).toBe(true);
    expect(anchored.sourceText).toBe("Hämoglobin    14.2 g/dL   (13.5-17.5)");
    expect(OCR.slice(anchored.sourceOffset!)).toContain(anchored.sourceText);
  });

  it("tolerates case drift and reflowed line breaks", () => {
    const anchored = anchorSourceText("metformin 500 MG twice daily", OCR);
    expect(anchored.anchored).toBe(true);
    expect(anchored.sourceText).toBe("Metformin 500 mg twice daily");
  });

  it("anchors a span the offset can be read back from", () => {
    const anchored = anchorSourceText("Befundbericht", OCR);
    expect(anchored.sourceOffset).not.toBeNull();
    expect(
      OCR.slice(
        anchored.sourceOffset!,
        anchored.sourceOffset! + anchored.sourceText.length,
      ),
    ).toBe(anchored.sourceText);
  });
});

describe("anchorSourceText — unlocatable quotes are unanchored", () => {
  it("drops a plausible-looking paraphrase the document never contained", () => {
    // Every word here appears somewhere in the document; the SENTENCE does not.
    const anchored = anchorSourceText(
      "Patient has diabetes and takes Metformin for it",
      OCR,
    );
    expect(anchored.anchored).toBe(false);
    expect(anchored.sourceText).toBe("");
    expect(anchored.sourceOffset).toBeNull();
  });

  it("drops an outright hallucinated value", () => {
    const anchored = anchorSourceText("Hämoglobin 9.1 g/dL", OCR);
    expect(anchored.anchored).toBe(false);
    expect(anchored.sourceText).toBe("");
  });

  it("refuses to anchor a quote too short to mean anything", () => {
    // "g" occurs many times; a match that short is noise, not provenance.
    const anchored = anchorSourceText("g", OCR);
    expect(anchored.anchored).toBe(false);
    expect(anchored.sourceText).toBe("");
  });

  it("is unanchored when there is no extracted text to verify against", () => {
    // Vision mode: the model read the rendered page, nothing can confirm it.
    const anchored = anchorSourceText(
      "Dx: Type 2 diabetes mellitus",
      undefined,
    );
    expect(anchored.anchored).toBe(false);
    expect(anchored.sourceText).toBe("");
    expect(anchored.sourceOffset).toBeNull();
  });

  it("is unanchored for an empty quote", () => {
    expect(anchorSourceText("   ", OCR).anchored).toBe(false);
  });
});
