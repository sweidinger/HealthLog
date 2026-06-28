import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.25 — optional extraction action.
 *
 * Pins the store-first fix: with NO vision provider configured, extraction
 * 422s on the ENHANCEMENT only — the already-stored document is left intact
 * (no fact-staging transaction, no status flip). This is the inverse of the
 * old behaviour where the absence of a provider blocked the upload itself.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findFirst: vi.fn(), update: vi.fn() },
    extractedFact: { deleteMany: vi.fn(), count: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((s: string) => `v1.${s}`),
  decrypt: vi.fn((s: string) => s.replace(/^v1\./u, "")),
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: vi.fn(() => new Uint8Array([1])),
  decryptFromBytes: vi.fn(() => "{}"),
}));

vi.mock("@/lib/labs/ocr-capability", () => ({
  resolveVisionProvider: vi.fn(),
  resolveTextProvider: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  assertConsentForChain: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-06-27"),
  reserveBudget: vi.fn().mockResolvedValue({ allowed: true, reserved: 1 }),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 1000),
}));
vi.mock("@/lib/documents/extract", () => ({
  runInboundExtraction: vi.fn(),
  InboundExtractError: class InboundExtractError extends Error {},
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 5, resetAt: Date.now() }),
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
import { requireModuleEnabled } from "@/lib/modules/gate";
import { resolveVisionProvider } from "@/lib/labs/ocr-capability";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function visionReq(id: string): NextRequest {
  // No JSON content-type → vision mode (operates on the stored original).
  return new NextRequest(
    new URL(`http://localhost/api/documents/inbound/${id}/extract`),
    { method: "POST" },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
  vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
    id: "doc-1",
    kind: "OTHER",
    contentEncrypted: new Uint8Array([1, 2, 3]),
    mimeType: "image/png",
    status: "STORED",
  } as never);
  vi.mocked(prisma.extractedFact.count).mockResolvedValue(0 as never);
});

describe("POST /api/documents/inbound/[id]/extract", () => {
  it("422s without a vision provider and leaves the stored row intact", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);

    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.meta?.errorCode).toBe("documents.inbound.providerUnsupported");

    // The stored document is untouched — no staging transaction, no flip.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.inboundDocument.update).not.toHaveBeenCalled();
  });

  it("409s and refuses re-extraction when any fact is already APPROVED", async () => {
    // A partially-confirmed document stays at EXTRACTED, so the CONFIRMED gate
    // does not catch it; the approved-fact guard must.
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
      kind: "OTHER",
      contentEncrypted: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      status: "EXTRACTED",
    } as never);
    vi.mocked(prisma.extractedFact.count).mockResolvedValue(2 as never);

    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.meta?.errorCode).toBe(
      "documents.inbound.alreadyPartlyConfirmed",
    );

    // No staging transaction, no fact deletion — committed provenance is safe.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.extractedFact.deleteMany).not.toHaveBeenCalled();
  });

  it("404s for a document the caller does not own", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(
      null as never,
    );
    const res = await POST(
      visionReq("foreign") as never,
      ctx("foreign") as never,
    );
    expect(res.status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
