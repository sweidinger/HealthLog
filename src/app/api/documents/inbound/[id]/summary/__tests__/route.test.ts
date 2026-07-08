import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * On-demand summary / extracted text (Document vault P2). Pins P2-D4 / A3:
 * session-only — the ONLY persistent side effects are the AI-budget ledger and
 * the audit log; no row, index, or fact is written or mutated.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findFirst: vi.fn(), update: vi.fn() },
    extractedFact: { create: vi.fn(), deleteMany: vi.fn() },
    documentContentIndex: { upsert: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(() => Buffer.from([1, 2, 3])),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({
  detectOcrMimeType: vi.fn(() => "image/png"),
}));
vi.mock("@/lib/documents/describe", () => ({
  runDocumentSummary: vi.fn(),
  transcribeDocument: vi.fn(),
  DocumentDescribeError: class DocumentDescribeError extends Error {},
}));
vi.mock("@/lib/documents/provider-order", () => ({
  resolveDocumentVisionProvider: vi.fn(),
  resolveDocumentTextProvider: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  assertDocumentEgressConsent: vi.fn().mockResolvedValue(undefined),
  ConsentRequiredError: class ConsentRequiredError extends Error {},
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-07-07"),
  reserveBudget: vi.fn().mockResolvedValue({ allowed: true, reserved: 1 }),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 1000),
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import { auditLog } from "@/lib/auth/audit";
import {
  runDocumentSummary,
  transcribeDocument,
} from "@/lib/documents/describe";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string, mode?: string) =>
  new NextRequest(
    new URL(
      `http://localhost/api/documents/inbound/${id}/summary${mode ? `?mode=${mode}` : ""}`,
    ),
    { method: "POST" },
  );

function assertNoPersistence(): void {
  expect(prisma.inboundDocument.update).not.toHaveBeenCalled();
  expect(prisma.documentContentIndex.upsert).not.toHaveBeenCalled();
  expect(prisma.extractedFact.create).not.toHaveBeenCalled();
  expect(prisma.extractedFact.deleteMany).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
    id: "doc-1",
    kind: "OTHER",
    contentEncrypted: new Uint8Array([1, 2, 3]),
    contentCodec: "binary2",
    mimeType: "image/png",
    status: "STORED",
  } as never);
  vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
    chain: [{ providerType: "anthropic", instance: {} }],
    pick: {
      entry: { providerType: "anthropic", instance: {} },
      providerType: "anthropic",
      pdfSupported: true,
    },
  } as never);
});

describe("POST /api/documents/inbound/[id]/summary", () => {
  it("mode=summary returns { summary } and persists only budget + audit", async () => {
    vi.mocked(runDocumentSummary).mockResolvedValue({
      summary: "A blood panel from a lab.",
    } as never);

    const res = await POST(
      req("doc-1", "summary") as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ summary: "A blood panel from a lab." });
    expect(auditLog).toHaveBeenCalledWith(
      "documents.inbound.summary",
      expect.anything(),
    );
    assertNoPersistence();
  });

  it("mode=text returns { text } session-only", async () => {
    vi.mocked(transcribeDocument).mockResolvedValue({
      text: "raw transcribed body",
    } as never);

    const res = await POST(
      req("doc-1", "text") as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ text: "raw transcribed body" });
    assertNoPersistence();
  });

  it("422s without a provider", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);
    const res = await POST(
      req("doc-1", "summary") as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(422);
    assertNoPersistence();
  });
});
