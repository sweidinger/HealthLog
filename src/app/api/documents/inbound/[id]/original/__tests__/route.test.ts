import { describe, it, expect, vi, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { NextRequest } from "next/server";

/**
 * v1.25.1 (W-DOCS-IN) — `GET /api/documents/inbound/[id]/original`.
 *
 * The route decrypts and serves the raw uploaded document. Load-bearing
 * behaviour under test: it is owner-scoped (the query narrows on the session
 * userId, so another user's document is a 404), it returns the decrypted bytes
 * with the stored MIME type, and it fails closed on a decrypt error.
 */

// A reversible crypto stub so encryptDocumentToBytes / decryptDocumentFromBytes
// round-trip without real keys. `decrypt` is overridden per-test for the
// fail-closed path.
const decryptMock = vi.fn((s: string) =>
  Buffer.from(s.replace(/^v1\./, ""), "base64").toString("utf8"),
);
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `v1.${Buffer.from(s, "utf8").toString("base64")}`,
  decrypt: (s: string) => decryptMock(s),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 239, resetAt: Date.now() }),
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

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { encryptDocumentToBytes } from "@/lib/documents/store";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

type Ctx = { params: Promise<{ id: string }> };
const callGet = GET as unknown as (
  req: NextRequest,
  ctx: Ctx,
) => Promise<Response>;

function makeReq(id: string): NextRequest {
  return new NextRequest(
    new URL(`http://localhost/api/documents/inbound/${id}/original`),
  );
}
function ctx(id: string): Ctx {
  return { params: Promise.resolve({ id }) };
}

const PDF_BYTES = Buffer.from("%PDF-1.7 fake report body");

beforeEach(() => {
  vi.clearAllMocks();
  decryptMock.mockImplementation((s: string) =>
    Buffer.from(s.replace(/^v1\./, ""), "base64").toString("utf8"),
  );
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("GET /api/documents/inbound/[id]/original", () => {
  it("returns the decrypted original with the stored MIME type, owner-scoped", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
      filename: "report.pdf",
      mimeType: "application/pdf",
      contentEncrypted: encryptDocumentToBytes(PDF_BYTES),
    } as never);

    const res = await callGet(makeReq("doc-1"), ctx("doc-1"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toContain("inline");
    expect(res.headers.get("Content-Disposition")).toContain("report.pdf");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const out = Buffer.from(await res.arrayBuffer());
    expect(out.equals(PDF_BYTES)).toBe(true);

    // The query is narrowed on the session userId + live rows only.
    const where = vi.mocked(prisma.inboundDocument.findFirst).mock.calls[0][0]
      ?.where as { id: string; userId: string; deletedAt: null };
    expect(where.userId).toBe("user-1");
    expect(where.id).toBe("doc-1");
    expect(where.deletedAt).toBeNull();
  });

  it("serves inline with a generated fallback name when filename is null", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-2",
      filename: null,
      mimeType: "image/png",
      contentEncrypted: encryptDocumentToBytes(Buffer.from("png bytes")),
    } as never);

    const res = await callGet(makeReq("doc-2"), ctx("doc-2"));
    expect(res.status).toBe(200);
    const disposition = res.headers.get("Content-Disposition") ?? "";
    // The stored set is inline-safe by construction → always inline.
    expect(disposition).toContain("inline");
    // No filename → generated fallback keyed by id + extension.
    expect(disposition).toContain("document-doc-2.png");
  });

  it("RFC 5987-encodes a non-ASCII filename and keeps an ASCII fallback", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-4",
      filename: "Müller-Bericht.pdf",
      mimeType: "application/pdf",
      contentEncrypted: encryptDocumentToBytes(PDF_BYTES),
    } as never);

    const res = await callGet(makeReq("doc-4"), ctx("doc-4"));
    expect(res.status).toBe(200);
    const disposition = res.headers.get("Content-Disposition") ?? "";
    // ASCII fallback: the non-ASCII byte is replaced so the bare `filename=`
    // value is header-safe; the RFC 5987 form carries the percent-encoded UTF-8.
    expect(disposition).toContain(`filename="M_ller-Bericht.pdf"`);
    expect(disposition).toContain("filename*=UTF-8''M%C3%BCller-Bericht.pdf");
  });

  it("404s for another user's document (the userId narrows it out)", async () => {
    // The owner-scoped where clause yields no row for a non-owner.
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(
      null as never,
    );

    const res = await callGet(makeReq("other-doc"), ctx("other-doc"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("fails closed (500) on a decrypt error — never serves ciphertext", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-3",
      filename: "report.pdf",
      mimeType: "application/pdf",
      contentEncrypted: encryptDocumentToBytes(PDF_BYTES),
    } as never);
    decryptMock.mockImplementation(() => {
      throw new Error("unknown key id");
    });

    const res = await callGet(makeReq("doc-3"), ctx("doc-3"));
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});
