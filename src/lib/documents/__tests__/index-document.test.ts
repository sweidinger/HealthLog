import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The AI-first / local-fallback content-index decision tree. Pins: a usable
 * provider takes the vision path; a text-layer PDF the provider cannot read
 * falls through to local; no provider / no consent / budget-out / provider
 * error all fall through to the free local path; decrypt + not-found fail
 * closed. No plaintext is asserted at the upsert boundary (source + ciphertext
 * path is the content-index module's concern, mocked here).
 */

vi.mock("@/lib/documents/ai-route-support", () => ({
  loadOwnedDocument: vi.fn(),
  prepareVisionInput: vi.fn(),
}));
vi.mock("@/lib/documents/content-index", () => ({
  upsertContentIndex: vi.fn().mockResolvedValue({ tokenCount: 5 }),
}));
vi.mock("@/lib/documents/describe", () => ({
  transcribeDocument: vi.fn(),
}));
vi.mock("@/lib/documents/local-extract", () => ({
  localExtractText: vi.fn(),
}));
vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(() => Buffer.from([1, 2, 3])),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({
  detectOcrMimeType: vi.fn(() => "application/pdf"),
}));
vi.mock("@/lib/labs/ocr-capability", () => ({
  resolveVisionProvider: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  assertConsentForChain: vi.fn().mockResolvedValue(undefined),
  ConsentRequiredError: class ConsentRequiredError extends Error {},
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-07-07"),
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 1000),
}));
vi.mock("@/lib/ai/ai-budgets", () => ({
  AI_BUDGETS: { documentTranscribe: { temperature: 0, maxTokens: 4000 } },
}));

import { indexDocumentContent } from "../index-document";
import { loadOwnedDocument, prepareVisionInput } from "@/lib/documents/ai-route-support";
import { upsertContentIndex } from "@/lib/documents/content-index";
import { transcribeDocument } from "@/lib/documents/describe";
import { localExtractText } from "@/lib/documents/local-extract";
import { decryptDocumentContent } from "@/lib/documents/store";
import { resolveVisionProvider } from "@/lib/labs/ocr-capability";
import {
  assertConsentForChain,
  ConsentRequiredError,
} from "@/lib/ai/consent-guard";
import { reserveBudget, reconcileSpend } from "@/lib/ai/coach/budget";

const DOC = {
  id: "doc-1",
  kind: "OTHER",
  contentEncrypted: new Uint8Array([1, 2, 3]),
  contentCodec: "binary2",
  mimeType: "application/pdf",
  status: "STORED",
};

const PICK = {
  chain: [{ providerType: "anthropic", instance: {} }],
  pick: {
    entry: { providerType: "anthropic", instance: {} },
    providerType: "anthropic",
    pdfSupported: true,
  },
};

function visionOk() {
  vi.mocked(prepareVisionInput).mockReturnValue({
    ok: true,
    images: [],
    documents: [{ mediaType: "application/pdf", dataBase64: "AA==" }],
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadOwnedDocument).mockResolvedValue(DOC as never);
  vi.mocked(reserveBudget).mockResolvedValue({
    allowed: true,
    reserved: 1,
  } as never);
  vi.mocked(localExtractText).mockResolvedValue({
    ok: true,
    text: "glucose fasting creatinine values report",
    source: "local-pdf",
  } as never);
});

describe("indexDocumentContent — provider-first path", () => {
  it("indexes via the provider (vision) when configured + consented", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue(PICK as never);
    visionOk();
    vi.mocked(transcribeDocument).mockResolvedValue({
      text: "haemoglobin 14.2 cholesterol 190",
    } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({ indexed: true, source: "vision", tokenCount: 5 });
    expect(transcribeDocument).toHaveBeenCalledTimes(1);
    expect(upsertContentIndex).toHaveBeenCalledWith(
      expect.objectContaining({ source: "vision", providerType: "anthropic" }),
    );
    // Budget reserved then reconciled at the full reserved amount (charged).
    expect(reconcileSpend).toHaveBeenCalledWith("user-1", 1, 1, "2026-07-07");
    // The local path is never touched when the provider succeeds.
    expect(localExtractText).not.toHaveBeenCalled();
  });
});

describe("indexDocumentContent — local fallback path", () => {
  it("falls back to local when NO provider is configured", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({
      indexed: true,
      source: "local-pdf",
      tokenCount: 5,
    });
    expect(transcribeDocument).not.toHaveBeenCalled();
    expect(upsertContentIndex).toHaveBeenCalledWith(
      expect.objectContaining({ source: "local-pdf", providerType: null }),
    );
  });

  it("falls back to local when consent is not granted", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue(PICK as never);
    vi.mocked(assertConsentForChain).mockRejectedValueOnce(
      new ConsentRequiredError("insights" as never),
    );

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toMatchObject({ indexed: true, source: "local-pdf" });
    expect(transcribeDocument).not.toHaveBeenCalled();
  });

  it("falls back to local when the provider cannot read the PDF", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue(PICK as never);
    vi.mocked(prepareVisionInput).mockReturnValue({
      ok: false,
      reason: "pdfNeedsAnthropic",
    } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toMatchObject({ indexed: true, source: "local-pdf" });
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(transcribeDocument).not.toHaveBeenCalled();
  });

  it("falls back to local when the daily budget is exhausted", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue(PICK as never);
    visionOk();
    vi.mocked(reserveBudget).mockResolvedValue({
      allowed: false,
      reserved: 0,
    } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toMatchObject({ indexed: true, source: "local-pdf" });
    expect(transcribeDocument).not.toHaveBeenCalled();
  });

  it("refunds and falls back to local when the provider call throws", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue(PICK as never);
    visionOk();
    vi.mocked(transcribeDocument).mockRejectedValueOnce(new Error("boom"));

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toMatchObject({ indexed: true, source: "local-pdf" });
    // Reservation refunded to zero spend.
    expect(reconcileSpend).toHaveBeenCalledWith("user-1", 1, 0, "2026-07-07");
    expect(localExtractText).toHaveBeenCalledTimes(1);
  });

  it("reports local-empty for a scanned PDF with no usable provider", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);
    vi.mocked(localExtractText).mockResolvedValue({
      ok: false,
      reason: "empty",
    } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({ indexed: false, reason: "local-empty" });
    expect(upsertContentIndex).not.toHaveBeenCalled();
  });
});

describe("indexDocumentContent — fail-closed", () => {
  it("returns not-found for an unknown / non-owned document", async () => {
    vi.mocked(loadOwnedDocument).mockResolvedValue(null as never);
    const outcome = await indexDocumentContent("user-1", "missing");
    expect(outcome).toEqual({ indexed: false, reason: "not-found" });
    expect(resolveVisionProvider).not.toHaveBeenCalled();
  });

  it("fails closed to decrypt-error when local decryption throws", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);
    vi.mocked(decryptDocumentContent).mockImplementationOnce(() => {
      throw new Error("bad key");
    });

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({ indexed: false, reason: "decrypt-error" });
    expect(upsertContentIndex).not.toHaveBeenCalled();
  });
});
