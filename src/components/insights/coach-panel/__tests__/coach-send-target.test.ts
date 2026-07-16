import { describe, it, expect } from "vitest";

import { resolveCoachSendTarget } from "../use-coach";

/**
 * v1.28.51 (Documents R3, Design A) — the prompt-injection fence rests on ONE
 * decision: a document-scoped turn must go to the hardened fenced document
 * endpoint and NEVER to the full Coach tool route (`/api/insights/chat`, which
 * injects the health snapshot + runs the write-tool loop). These tests pin that
 * branch so a regression that routes untrusted document text through the tool
 * loop fails loudly here.
 */
describe("resolveCoachSendTarget", () => {
  it("routes a doc-scoped turn to the fenced document endpoint, never the tool route", () => {
    const target = resolveCoachSendTarget({
      conversationId: "conv-1",
      message: "What does this lab say?",
      documentId: "doc-abc",
      // Coach-only fields that MUST NOT influence the fenced path.
      scope: { sources: ["bp"] },
      guidedQuestion: "how are you sleeping?",
      prefill: "seed",
    });

    expect(target.url).toBe("/api/documents/inbound/doc-abc/chat");
    // The acceptance criterion above all others: a doc turn never hits the
    // coach tool route.
    expect(target.url).not.toBe("/api/insights/chat");
    expect(target.url).not.toContain("/api/insights/chat");

    const body = JSON.parse(target.body);
    expect(body).toEqual({
      conversationId: "conv-1",
      message: "What does this lab say?",
      locale: undefined,
    });
    // The tool-driving fields are stripped — the fenced endpoint has no tools,
    // no snapshot, no guided flow.
    expect(body).not.toHaveProperty("scope");
    expect(body).not.toHaveProperty("guidedQuestion");
    expect(body).not.toHaveProperty("prefill");
  });

  it("URL-encodes the document id in the fenced path", () => {
    const target = resolveCoachSendTarget({
      message: "hi",
      documentId: "doc/../etc",
    });
    expect(target.url).toBe("/api/documents/inbound/doc%2F..%2Fetc/chat");
  });

  it("routes a normal health turn to the Coach tool route", () => {
    const target = resolveCoachSendTarget({
      conversationId: "conv-2",
      message: "How is my BP trending?",
      scope: { sources: ["bp"] },
      guidedQuestion: "q",
    });
    expect(target.url).toBe("/api/insights/chat");
    const body = JSON.parse(target.body);
    expect(body.message).toBe("How is my BP trending?");
    expect(body.scope).toEqual({ sources: ["bp"] });
    expect(body.guidedQuestion).toBe("q");
  });

  it.each([undefined, null, ""])(
    "treats %p documentId as a normal health turn (tool route)",
    (documentId) => {
      const target = resolveCoachSendTarget({
        message: "hello",
        documentId: documentId as string | null | undefined,
      });
      expect(target.url).toBe("/api/insights/chat");
    },
  );
});
