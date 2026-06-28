import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.25 — documents library: store-only upload + browsable list.
 *
 * Pins the store-first inversion: a file uploads + persists as a STORED row
 * with NO provider / consent / budget call on the path (a self-hoster with no
 * document-scan provider can still file documents), and the list honours the
 * `q` / `kind` filters with keyset pagination.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((s: string) => `v1.${s}`),
  decrypt: vi.fn((s: string) => s.replace(/^v1\./u, "")),
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 3_600_000,
  }),
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

import { POST, GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";

const post = POST as unknown as (r: Request) => Promise<Response>;
const get = GET as unknown as (r: Request) => Promise<Response>;

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==";

function mkUpload(fields: Record<string, string> = {}) {
  const body = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");
  const blobBytes = new Uint8Array(body.byteLength);
  blobBytes.set(body);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([blobBytes], { type: "image/png" }),
    "x.png",
  );
  for (const [k, v] of Object.entries(fields)) formData.append(k, v);
  return new Request("http://localhost/api/documents/inbound", {
    method: "POST",
    body: formData,
  });
}

function docRow(over: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    userId: "user-1",
    kind: "OTHER",
    title: null,
    filename: "x.png",
    mimeType: "image/png",
    byteSize: 70,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: null,
    errorReason: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
});

describe("POST /api/documents/inbound (store-only)", () => {
  it("stores a file as STORED with no provider call and returns 201", async () => {
    vi.mocked(prisma.inboundDocument.create).mockResolvedValue(
      docRow({ kind: "LAB_RESULT", title: "Blood panel" }) as never,
    );

    const res = await post(
      mkUpload({ title: "Blood panel", kind: "LAB_RESULT" }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data.status).toBe("STORED");
    expect(body.data.kind).toBe("LAB_RESULT");
    expect(body.data.title).toBe("Blood panel");

    // The row is created with status STORED, no provider, userId from session.
    const arg = vi.mocked(prisma.inboundDocument.create).mock.calls[0][0];
    expect(arg.data.status).toBe("STORED");
    expect(arg.data.userId).toBe("user-1");
    expect(arg.data.kind).toBe("LAB_RESULT");
    expect("providerType" in arg.data).toBe(false);
    // No userId smuggled from the form is honoured — it comes from the session.
    expect(arg.data.userId).toBe("user-1");
  });

  it("rejects a non-image/pdf payload with 415", async () => {
    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array([1, 2, 3, 4])]), "x.bin");
    const req = new Request("http://localhost/api/documents/inbound", {
      method: "POST",
      body: formData,
    });
    const res = await post(req);
    expect(res.status).toBe(415);
    expect(prisma.inboundDocument.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/documents/inbound (list)", () => {
  it("applies q + kind filters and returns a keyset page", async () => {
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([
      { ...docRow({ id: "d1" }), _count: { facts: 0 }, facts: [] },
      { ...docRow({ id: "d2" }), _count: { facts: 2 }, facts: [{ id: "f1" }] },
    ] as never);

    const res = await get(
      new Request(
        "http://localhost/api/documents/inbound?q=panel&kind=LAB_RESULT&sort=createdAt&order=desc&limit=10",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.documents).toHaveLength(2);
    expect(body.data.nextCursor).toBeNull();

    const arg = vi.mocked(prisma.inboundDocument.findMany).mock.calls[0][0];
    expect(arg.where.userId).toBe("user-1");
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.where.kind).toBe("LAB_RESULT");
    expect(arg.where.OR).toEqual([
      { title: { contains: "panel", mode: "insensitive" } },
      { filename: { contains: "panel", mode: "insensitive" } },
    ]);
    // limit+1 fetched for the has-more probe.
    expect(arg.take).toBe(11);
  });

  it("emits nextCursor when a full page+1 is returned", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      ...docRow({ id: `d${i}` }),
      _count: { facts: 0 },
      facts: [],
    }));
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue(rows as never);

    const res = await get(
      new Request("http://localhost/api/documents/inbound?limit=2"),
    );
    const body = await res.json();
    expect(body.data.documents).toHaveLength(2);
    expect(body.data.nextCursor).toBe("d1");
  });

  it("422s on a bad sort value", async () => {
    const res = await get(
      new Request("http://localhost/api/documents/inbound?sort=nope"),
    );
    expect(res.status).toBe(422);
  });
});
