import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexClient } from "../codex-client";

/**
 * Build a `Response` whose `.body` streams a list of SSE event strings.
 * Mirrors the wire format the Codex backend emits (each event terminated
 * with `\n\n`).
 */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(encoder.encode(ev));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const messageDoneEvent = (text: string) =>
  `event: response.output_item.done\ndata: ${JSON.stringify({
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  })}\n\n`;

const completedEvent = (totalTokens = 50) =>
  `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { id: "resp1", usage: { total_tokens: totalTokens } },
  })}\n\n`;

describe("CodexClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("assembles assistant text from output_item.done events", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([messageDoneEvent('{"summary":"ok"}'), completedEvent(50)]),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test-token",
      onTokenRefresh: vi.fn(),
    });

    const result = await client.generateCompletion({
      systemPrompt: "You are a doctor.",
      userPrompt: "Analyze this.",
    });

    expect(result.content).toBe('{"summary":"ok"}');
    expect(result.providerType).toBe("codex");
    expect(result.tokensUsed).toBe(50);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sentBody.stream).toBe(true);
    expect(Array.isArray(sentBody.input)).toBe(true);
    expect(sentBody.input[0].content[0]).toEqual({
      type: "input_text",
      text: "Analyze this.",
    });
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  it("falls back to concatenated output_text deltas when no done event arrived", async () => {
    const deltaEvent = (delta: string) =>
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta,
      })}\n\n`;
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          deltaEvent("Hello "),
          deltaEvent("world"),
          completedEvent(),
        ]),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "test-token",
      onTokenRefresh: vi.fn(),
    });
    const result = await client.generateCompletion({
      systemPrompt: "test",
      userPrompt: "test",
    });
    expect(result.content).toBe("Hello world");
  });

  it("calls onTokenRefresh on 401 and retries", async () => {
    const newToken = "refreshed-token";
    const onRefresh = vi.fn().mockResolvedValue(newToken);

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("unauthorized"),
      })
      .mockResolvedValueOnce(
        sseResponse([messageDoneEvent('{"test":true}'), completedEvent()]),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "expired-token",
      onTokenRefresh: onRefresh,
    });

    const result = await client.generateCompletion({
      systemPrompt: "test",
      userPrompt: "test",
    });

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(result.content).toBe('{"test":true}');
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe(
      `Bearer ${newToken}`,
    );
  });

  it("throws after retry if still 401", async () => {
    const onRefresh = vi.fn().mockResolvedValue("still-bad");

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("unauthorized"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new CodexClient({
      accessToken: "bad",
      onTokenRefresh: onRefresh,
    });

    await expect(
      client.generateCompletion({ systemPrompt: "test", userPrompt: "test" }),
    ).rejects.toThrow("Codex request failed after token refresh (401)");
  });

  it("throws on non-401 errors without retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("server error"),
      }),
    );

    const onRefresh = vi.fn();
    const client = new CodexClient({
      accessToken: "test",
      onTokenRefresh: onRefresh,
    });

    await expect(
      client.generateCompletion({ systemPrompt: "test", userPrompt: "test" }),
    ).rejects.toThrow("Codex request failed (500)");
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
