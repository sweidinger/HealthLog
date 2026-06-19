import { describe, expect, it, vi } from "vitest";

// Mock the db + crypto boundaries so `recordProactiveNudge` can be
// exercised without a real Postgres / encryption key. The transaction
// runner simply invokes the callback with the stubbed `tx`.
const txCreate = {
  coachConversation: { create: vi.fn() },
  coachMessage: { create: vi.fn() },
};
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(async (cb: (tx: typeof txCreate) => Promise<unknown>) =>
      cb(txCreate),
    ),
  },
}));
vi.mock("../bytes-codec", () => ({
  encryptToBytes: vi.fn((text: string) =>
    new TextEncoder().encode(`enc:${text}`),
  ),
  decryptFromBytes: vi.fn(),
}));

import { recordProactiveNudge, summariseTitle } from "../persistence";
import { encryptToBytes } from "../bytes-codec";

describe("summariseTitle", () => {
  it("returns the input unchanged when below 80 chars", () => {
    const out = summariseTitle("Why is my BP higher this week?");
    expect(out).toBe("Why is my BP higher this week?");
  });

  it("collapses runs of whitespace", () => {
    const out = summariseTitle("Why    is\n\tmy BP\thigher?");
    expect(out).toBe("Why is my BP higher?");
  });

  it("trims leading and trailing whitespace", () => {
    const out = summariseTitle("   plenty of room   ");
    expect(out).toBe("plenty of room");
  });

  it("appends ellipsis when input is over 80 chars", () => {
    const long =
      "Could you walk me through the relationship between my morning blood pressure spikes and the late evening medication doses I took last week, including any noticeable patterns?";
    const out = summariseTitle(long);
    expect(out.endsWith("…")).toBe(true);
    // Visible width capped to 80
    expect([...out].length).toBeLessThanOrEqual(80);
  });

  it("cuts at a word boundary when one is within reach", () => {
    const long =
      "Walk me through the morning blood pressure trend I have been tracking since the last visit at the clinic in Hamburg this past month";
    const out = summariseTitle(long);
    // No trailing whitespace before the ellipsis
    expect(out).not.toMatch(/\s+…$/);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to a default title for empty input", () => {
    expect(summariseTitle("")).toBe("New conversation");
    expect(summariseTitle("    ")).toBe("New conversation");
  });
});

describe("recordProactiveNudge", () => {
  it("creates a conversation + an encrypted ASSISTANT message in one transaction", async () => {
    const now = new Date("2026-06-18T05:15:00.000Z");
    txCreate.coachConversation.create.mockResolvedValue({
      id: "conv_1",
      userId: "user_1",
      title: "Time to weigh in",
      createdAt: now,
      updatedAt: now,
    });
    txCreate.coachMessage.create.mockResolvedValue({
      id: "msg_1",
      createdAt: now,
    });

    const out = await recordProactiveNudge({
      userId: "user_1",
      title: "Time to weigh in",
      body: "It has been a week — a quick weigh-in keeps the trend honest.",
    });

    expect(out).toEqual({
      conversationId: "conv_1",
      messageId: "msg_1",
      createdAt: now,
    });

    // Conversation owned by the user, title summarised.
    expect(txCreate.coachConversation.create).toHaveBeenCalledWith({
      data: { userId: "user_1", title: "Time to weigh in" },
    });

    // The body is encrypted at rest (Bytes), role is assistant, and the
    // message hangs off the new conversation. No raw plaintext column.
    const msgArg = txCreate.coachMessage.create.mock.calls[0][0];
    expect(msgArg.data.conversationId).toBe("conv_1");
    expect(msgArg.data.role).toBe("assistant");
    expect(msgArg.data.providerType).toBe("nudge");
    expect(encryptToBytes).toHaveBeenCalledWith(
      "It has been a week — a quick weigh-in keeps the trend honest.",
    );
    // The stored column is the ciphertext, never the plaintext body.
    expect(new TextDecoder().decode(msgArg.data.encryptedContent)).toContain(
      "enc:",
    );
  });
});
