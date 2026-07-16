/**
 * v1.29.x (S7) — the coach-conversation ↔ document join model against a REAL
 * Postgres (migration 0245 applied by globalSetup). Pins the security-load-
 * bearing invariants of the data model that the unit mocks cannot:
 *   - the sticky `documentScoped` flag isolates fenced threads from the tool
 *     route's `documentScoped: false` fetch (adversarial test 2);
 *   - the single-doc sheet's `attachedDocumentId` join filter (test 13);
 *   - deleting a document CASCADES its join rows away but leaves the fenced
 *     conversation alive with the flag still true (§1.4 / §5.3);
 *   - detach removes the row but never clears the flag;
 *   - the §6.3 post-migration invariant holds (no documentScoped=false row with
 *     a live join row).
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import {
  attachDocument,
  createConversation,
  detachDocument,
  fetchConversationWithMessages,
} from "@/lib/ai/coach/persistence";

import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function seedUser(username: string) {
  return getPrismaClient().user.create({
    data: {
      username,
      email: `${username}@example.test`,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
}

async function seedDocument(userId: string, title: string) {
  return getPrismaClient().inboundDocument.create({
    data: {
      userId,
      title,
      filename: `${title}.pdf`,
      mimeType: "application/pdf",
      byteSize: 10,
      contentEncrypted: Buffer.from("ciphertext"),
      contentCodec: "binary2",
    },
  });
}

describe("coach_conversation_documents — real Postgres", () => {
  it("creates a fenced conversation with join rows; the tool-route fetch (documentScoped:false) cannot see it", async () => {
    const user = await seedUser("fencer");
    const docA = await seedDocument(user.id, "labs");
    const docB = await seedDocument(user.id, "report");

    const conv = await createConversation({
      userId: user.id,
      title: "About my labs",
      documentScoped: true,
      attachmentIds: [docA.id, docB.id],
    });
    expect(conv.fenced).toBe(true);

    // Fenced fetch sees both attachments; tool-route fetch is blind to it.
    const fenced = await fetchConversationWithMessages(user.id, conv.id, {
      documentScoped: true,
    });
    expect(fenced?.attachmentCount).toBe(2);
    expect((fenced?.attachments ?? []).map((a) => a.documentId).sort()).toEqual(
      [docA.id, docB.id].sort(),
    );

    const asTool = await fetchConversationWithMessages(user.id, conv.id, {
      documentScoped: false,
    });
    expect(asTool).toBeNull();
  });

  it("the single-doc sheet fetch requires a live join row for the path id", async () => {
    const user = await seedUser("sheeter");
    const docA = await seedDocument(user.id, "a");
    const docB = await seedDocument(user.id, "b");
    const conv = await createConversation({
      userId: user.id,
      title: "t",
      documentScoped: true,
      attachmentIds: [docA.id],
    });
    // Holds docA → resolves.
    expect(
      await fetchConversationWithMessages(user.id, conv.id, {
        attachedDocumentId: docA.id,
      }),
    ).not.toBeNull();
    // Does NOT hold docB → 404 for that path id.
    expect(
      await fetchConversationWithMessages(user.id, conv.id, {
        attachedDocumentId: docB.id,
      }),
    ).toBeNull();
  });

  it("deleting a document cascades its join row away but leaves the fenced conversation alive (flag stays true)", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("deleter");
    const doc = await seedDocument(user.id, "doomed");
    const conv = await createConversation({
      userId: user.id,
      title: "t",
      documentScoped: true,
      attachmentIds: [doc.id],
    });

    await prisma.inboundDocument.delete({ where: { id: doc.id } });

    const rows = await prisma.coachConversationDocument.count({
      where: { conversationId: conv.id },
    });
    expect(rows).toBe(0); // join row cascaded away
    const stillThere = await prisma.coachConversation.findUnique({
      where: { id: conv.id },
      select: { documentScoped: true },
    });
    expect(stillThere).not.toBeNull(); // conversation survives
    expect(stillThere?.documentScoped).toBe(true); // and stays fenced
  });

  it("detach removes the join row but NEVER clears the sticky flag", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("detacher");
    const doc = await seedDocument(user.id, "d");
    const conv = await createConversation({
      userId: user.id,
      title: "t",
      documentScoped: true,
      attachmentIds: [doc.id],
    });

    const removed = await detachDocument({
      userId: user.id,
      conversationId: conv.id,
      documentId: doc.id,
    });
    expect(removed).toBe(true);
    const row = await prisma.coachConversation.findUnique({
      where: { id: conv.id },
      select: { documentScoped: true },
    });
    expect(row?.documentScoped).toBe(true); // fenced forever
  });

  it("attachDocument flips a tool conversation to fenced (and never back)", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("flipper");
    const doc = await seedDocument(user.id, "d");
    // A plain tool conversation.
    const conv = await createConversation({ userId: user.id, title: "health" });
    expect(conv.fenced).toBe(false);

    await attachDocument({ conversationId: conv.id, documentId: doc.id });
    const flipped = await prisma.coachConversation.findUnique({
      where: { id: conv.id },
      select: { documentScoped: true },
    });
    expect(flipped?.documentScoped).toBe(true);
  });

  it("§6.3 invariant: no documentScoped=false conversation ever has a live join row", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("invariant");
    const doc = await seedDocument(user.id, "d");
    await createConversation({
      userId: user.id,
      title: "fenced",
      documentScoped: true,
      attachmentIds: [doc.id],
    });
    await createConversation({ userId: user.id, title: "health" });

    const violators = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM coach_conversations c
      WHERE c.document_scoped = false
        AND EXISTS (
          SELECT 1 FROM coach_conversation_documents d
          WHERE d.conversation_id = c.id
        )`;
    expect(violators).toHaveLength(0);
  });
});
