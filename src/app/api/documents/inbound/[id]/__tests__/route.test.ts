import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.25 — documents library: owner-scoped metadata edit.
 *
 * Pins that PATCH is owner-scoped (a caller cannot touch another user's
 * document — the `where` carries the session userId, so a foreign row resolves
 * to a 404) and that an own-row edit sets only the sent fields (no mass
 * assignment).
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: {
      findFirst: vi.fn(),
      update: vi.fn(),
      findFirstOrThrow: vi.fn(),
    },
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

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
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

import { PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function mkReq(id: string, body: unknown): NextRequest {
  return new NextRequest(
    new URL(`http://localhost/api/documents/inbound/${id}`),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function docRow(over: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    userId: "user-1",
    kind: "DOCTOR_REPORT",
    title: "Renamed",
    filename: "x.png",
    mimeType: "image/png",
    byteSize: 70,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: new Date("2026-05-01T00:00:00.000Z"),
    errorReason: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    facts: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
});

describe("PATCH /api/documents/inbound/[id]", () => {
  it("cannot touch another user's document (404, no update)", async () => {
    // The foreign row does not satisfy `{ id, userId, deletedAt: null }`.
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(
      null as never,
    );

    const res = await PATCH(
      mkReq("foreign-doc", { title: "hijack" }) as never,
      ctx("foreign-doc") as never,
    );
    expect(res.status).toBe(404);
    expect(prisma.inboundDocument.update).not.toHaveBeenCalled();

    const where = vi.mocked(prisma.inboundDocument.findFirst).mock.calls[0]![0]!
      .where!;
    expect(where.userId).toBe("user-1");
    expect(where.deletedAt).toBeNull();
  });

  it("edits only the sent fields on an owned document", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
    } as never);
    vi.mocked(prisma.inboundDocument.update).mockResolvedValue(
      docRow() as never,
    );
    vi.mocked(prisma.inboundDocument.findFirstOrThrow).mockResolvedValue(
      docRow({ kind: "IMAGING", title: "Renamed" }) as never,
    );

    const res = await PATCH(
      mkReq("doc-1", { title: "Renamed", kind: "IMAGING" }) as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);

    const arg = vi.mocked(prisma.inboundDocument.update).mock.calls[0][0];
    expect(arg.where).toEqual({ id: "doc-1" });
    expect(arg.data.title).toBe("Renamed");
    expect(arg.data.kind).toBe("IMAGING");
    // documentDate was not sent → not present in the update payload.
    expect("documentDate" in arg.data).toBe(false);
  });

  it("422s on an empty update", async () => {
    const res = await PATCH(mkReq("doc-1", {}) as never, ctx("doc-1") as never);
    expect(res.status).toBe(422);
    expect(prisma.inboundDocument.findFirst).not.toHaveBeenCalled();
  });
});
