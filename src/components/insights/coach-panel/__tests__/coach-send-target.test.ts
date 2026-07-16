import { describe, it, expect } from "vitest";

import { resolveCoachSendTarget } from "../use-coach";

/**
 * v1.29.x (S7) — the prompt-injection fence rests on ONE decision: a FENCED turn
 * must go to the hardened `/api/insights/chat/fenced` endpoint and NEVER to the
 * full Coach tool route (`/api/insights/chat`, which injects the health snapshot
 * + runs the write-tool loop). A turn is fenced when the loaded conversation's
 * server `fenced` flag is true OR the composer has staged first-turn attachments.
 * These tests pin that branch so a regression that routes untrusted document text
 * through the tool loop fails loudly here.
 */
describe("resolveCoachSendTarget", () => {
  it("routes a fenced conversation (server flag) to the fenced endpoint, never the tool route", () => {
    const target = resolveCoachSendTarget({
      conversationId: "conv-1",
      message: "What does this lab say?",
      fenced: true,
      // Coach-only fields that MUST NOT influence the fenced path.
      scope: { sources: ["bp"] },
      guidedQuestion: "how are you sleeping?",
      prefill: "seed",
    });

    expect(target.url).toBe("/api/insights/chat/fenced");
    expect(target.url).not.toContain("/api/insights/chat?");
    expect(target.url.endsWith("/chat")).toBe(false);

    const body = JSON.parse(target.body);
    // Existing conversation → NO attachmentIds (attach-to-existing uses the
    // attach endpoint), and none of the tool-mode fields.
    expect(body).toEqual({
      conversationId: "conv-1",
      message: "What does this lab say?",
    });
    expect(body).not.toHaveProperty("scope");
    expect(body).not.toHaveProperty("guidedQuestion");
    expect(body).not.toHaveProperty("prefill");
    expect(body).not.toHaveProperty("attachmentIds");
  });

  it("routes a NEW chat with staged attachments to the fenced endpoint, carrying attachmentIds", () => {
    const target = resolveCoachSendTarget({
      message: "summarise these",
      pendingAttachmentIds: ["doc-a", "doc-b"],
    });
    expect(target.url).toBe("/api/insights/chat/fenced");
    const body = JSON.parse(target.body);
    expect(body.attachmentIds).toEqual(["doc-a", "doc-b"]);
    expect(body).not.toHaveProperty("conversationId");
  });

  it("the fenced flag wins even without pending attachments", () => {
    const target = resolveCoachSendTarget({
      conversationId: "conv-9",
      message: "hi",
      fenced: true,
      pendingAttachmentIds: [],
    });
    expect(target.url).toBe("/api/insights/chat/fenced");
  });

  it("an EXISTING conversation NEVER emits attachmentIds even if pending ids are set", () => {
    // Attach-to-existing must go through the attach endpoint, not a first-turn
    // payload — the function drops attachmentIds when a conversationId exists.
    const target = resolveCoachSendTarget({
      conversationId: "conv-2",
      message: "hi",
      fenced: true,
      pendingAttachmentIds: ["doc-x"],
    });
    expect(target.url).toBe("/api/insights/chat/fenced");
    const body = JSON.parse(target.body);
    expect(body).not.toHaveProperty("attachmentIds");
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

  it.each([undefined, false])(
    "treats fenced=%p with no pending attachments as a normal health turn (tool route)",
    (fenced) => {
      const target = resolveCoachSendTarget({
        message: "hello",
        fenced: fenced as boolean | undefined,
        pendingAttachmentIds: [],
      });
      expect(target.url).toBe("/api/insights/chat");
    },
  );
});
