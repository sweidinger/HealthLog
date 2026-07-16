import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * v1.28.51 (Documents R3, Design A) — the Coach rail + detail READERS now
 * surface document-scoped threads alongside health threads (the DTO carries
 * `documentId` + `documentTitle`). These tests pin two invariants of the
 * filter relaxation:
 *   1. Relaxing the `documentId` scope must NEVER relax the `userId` scope —
 *      ownership stays narrowed on every read.
 *   2. Omitting the `documentId` option drops the scope filter (a union of both
 *      health + doc threads); passing it keeps the filter (the document route's
 *      own isolation is unchanged).
 * The DTO now resolves `documentTitle` from the joined document.
 */

const findMany = vi.fn();
const findFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    coachConversation: {
      findMany: (...args: unknown[]) => findMany(...args),
      findFirst: (...args: unknown[]) => findFirst(...args),
    },
  },
}));

vi.mock("../bytes-codec", () => ({
  encryptToBytes: vi.fn(),
  decryptFromBytes: vi.fn(() => "decrypted body"),
}));

import {
  fetchConversationWithMessages,
  listConversations,
} from "../persistence";

const now = new Date("2026-07-16T10:00:00.000Z");

beforeEach(() => {
  findMany.mockReset();
  findFirst.mockReset();
});

describe("listConversations — filter relaxation + DTO", () => {
  it("omits the documentId filter when no documentId is passed (union of both scopes), but keeps userId narrowed", async () => {
    findMany.mockResolvedValue([
      {
        id: "c1",
        title: "Health thread",
        createdAt: now,
        updatedAt: now,
        documentId: null,
        _count: { messages: 3 },
        document: null,
      },
      {
        id: "c2",
        title: "Doc thread",
        createdAt: now,
        updatedAt: now,
        documentId: "doc-1",
        _count: { messages: 2 },
        document: { title: "Blood panel", filename: "panel.pdf" },
      },
    ]);

    const page = await listConversations({ userId: "user-1" });

    const where = findMany.mock.calls[0][0].where;
    // userId stays narrowed — the relaxation never widens ownership.
    expect(where.userId).toBe("user-1");
    // No documentId key at all → no scope filter → both scopes returned.
    expect("documentId" in where).toBe(false);

    // The DTO now carries the scope discriminator + resolved title.
    expect(page.conversations[0]).toMatchObject({
      id: "c1",
      documentId: null,
      documentTitle: null,
    });
    expect(page.conversations[1]).toMatchObject({
      id: "c2",
      documentId: "doc-1",
      documentTitle: "Blood panel",
    });
  });

  it("still applies the documentId filter when the document route passes it (isolation unchanged)", async () => {
    findMany.mockResolvedValue([]);
    await listConversations({ userId: "user-1", documentId: "doc-9" });
    const where = findMany.mock.calls[0][0].where;
    expect(where.userId).toBe("user-1");
    expect(where.documentId).toBe("doc-9");
  });

  it("falls back to filename when the document has no title", async () => {
    findMany.mockResolvedValue([
      {
        id: "c3",
        title: "t",
        createdAt: now,
        updatedAt: now,
        documentId: "doc-3",
        _count: { messages: 1 },
        document: { title: null, filename: "scan.pdf" },
      },
    ]);
    const page = await listConversations({ userId: "user-1" });
    expect(page.conversations[0].documentTitle).toBe("scan.pdf");
  });
});

describe("fetchConversationWithMessages — filter relaxation + DTO", () => {
  it("reads across both scopes (no documentId filter) while keeping userId narrowed", async () => {
    findFirst.mockResolvedValue({
      id: "c2",
      title: "Doc thread",
      createdAt: now,
      updatedAt: now,
      documentId: "doc-1",
      summaryEncrypted: null,
      document: { title: "Blood panel", filename: "panel.pdf" },
      messages: [
        {
          id: "m1",
          role: "user",
          encryptedContent: new Uint8Array(),
          metricSourceJson: null,
          providerType: null,
          promptVersion: null,
          tokensUsed: null,
          model: null,
          createdAt: now,
        },
      ],
    });

    const detail = await fetchConversationWithMessages("user-1", "c2");

    const where = findFirst.mock.calls[0][0].where;
    expect(where.id).toBe("c2");
    expect(where.userId).toBe("user-1");
    // No documentId opt → no scope filter (the relaxed coach detail reader).
    expect("documentId" in where).toBe(false);

    expect(detail?.documentId).toBe("doc-1");
    expect(detail?.documentTitle).toBe("Blood panel");
  });

  it("keeps the documentId filter when the document route passes it", async () => {
    findFirst.mockResolvedValue(null);
    await fetchConversationWithMessages("user-1", "c2", {
      documentId: "doc-1",
    });
    const where = findFirst.mock.calls[0][0].where;
    expect(where.userId).toBe("user-1");
    expect(where.documentId).toBe("doc-1");
  });

  it("keeps the strict null-scope filter when the coach SEND path passes documentId: null", async () => {
    findFirst.mockResolvedValue(null);
    await fetchConversationWithMessages("user-1", "c2", { documentId: null });
    const where = findFirst.mock.calls[0][0].where;
    expect(where.userId).toBe("user-1");
    // The tool-route send path stays fenced to health threads.
    expect(where.documentId).toBeNull();
  });
});
