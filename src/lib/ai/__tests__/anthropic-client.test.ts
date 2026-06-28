import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnthropicClient } from "../anthropic-client";
import { singleUserTurn } from "../types";

// safeFetch's requirePublicHost path runs through undici's own `fetch`
// (version-locked with its dispatcher). Delegate it to the global `fetch`
// stub these tests install so the existing interception still applies.
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (input: unknown, init?: unknown) =>
      (globalThis.fetch as unknown as (i: unknown, n?: unknown) => unknown)(
        input,
        init,
      ),
  };
});

describe("AnthropicClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct request shape with required headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: "text", text: '{"summary":"ok"}' }],
          usage: { input_tokens: 30, output_tokens: 12 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new AnthropicClient({
      apiKey: "sk-ant-test-key",
      model: "claude-3-5-sonnet-latest",
    });

    const result = await client.generateCompletion(
      singleUserTurn({
        system: "You are a doctor.",
        user: "Analyze this data.",
        temperature: 0.4,
        maxTokens: 800,
      }),
    );

    expect(result.content).toBe('{"summary":"ok"}');
    expect(result.tokensUsed).toBe(42);
    expect(result.model).toBe("claude-3-5-sonnet-latest");
    expect(result.providerType).toBe("anthropic");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");

    expect(init.headers["x-api-key"]).toBe("sk-ant-test-key");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-3-5-sonnet-latest");
    expect(body.max_tokens).toBe(800);
    expect(body.temperature).toBe(0.4);
    // v1.20.0 — system is a top-level cache-marked text block (NOT a message).
    expect(body.system).toEqual([
      {
        type: "text",
        text: "You are a doctor.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(body.messages).toEqual([expect.objectContaining({ role: "user" })]);
    // User message carries the original text plus the JSON-coercion instruction.
    expect(body.messages[0].content).toContain("Analyze this data.");
    expect(body.messages[0].content.toLowerCase()).toContain("json");
  });

  it("prefills the assistant turn with `{` and re-prepends it for JSON surfaces", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          // Model continues from the prefilled `{`, so its text omits it.
          content: [{ type: "text", text: '"summary":"ok"}' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new AnthropicClient({
      apiKey: "sk-ant-test",
      model: "claude-3-5-sonnet-latest",
    });

    const result = await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u", responseFormat: "json" }),
    );

    // The returned content is the complete object (the `{` re-prepended).
    expect(result.content).toBe('{"summary":"ok"}');
    expect(JSON.parse(result.content)).toEqual({ summary: "ok" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toEqual({ role: "assistant", content: "{" });
  });

  it("does NOT prefill for the prose (non-JSON) path", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: "text", text: "Just some prose." }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new AnthropicClient({
      apiKey: "sk-ant-test",
      model: "claude-3-5-sonnet-latest",
    });

    const result = await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u" }),
    );

    expect(result.content).toBe("Just some prose.");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
  });

  it("uses custom baseUrl when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: "text", text: "{}" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new AnthropicClient({
      apiKey: "sk-ant-x",
      model: "claude-3-haiku-20240307",
      baseUrl: "https://api.anthropic.example/v1/",
    });

    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.anthropic.example/v1/messages",
    );
  });

  it("captures structured error fields and redacts the API key on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 529,
        text: () =>
          Promise.resolve(
            "overloaded; debug=sk-ant-supersecretkey1234567890 leaked",
          ),
      }),
    );

    const client = new AnthropicClient({
      apiKey: "sk-ant-test",
      model: "claude-3-5-sonnet-latest",
    });

    let caught: unknown;
    try {
      await client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      httpStatus?: number;
      upstream?: string;
      bodyExcerpt?: string;
      model?: string;
    };
    expect(err.message).toBe("Anthropic request failed (529)");
    expect(err.httpStatus).toBe(529);
    expect(err.upstream).toBe("anthropic");
    expect(err.model).toBe("claude-3-5-sonnet-latest");
    expect(err.bodyExcerpt).toContain("sk-ant-***redacted***");
    expect(err.bodyExcerpt).not.toContain("supersecretkey");
  });

  it("folds image + document blocks into the user turn for vision (Lab-OCR)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: "text", text: '"rows":[]}' }],
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new AnthropicClient({
      apiKey: "sk-ant-x",
      model: "claude-sonnet-4-6",
    });

    await client.generateCompletion(
      singleUserTurn({
        system: "Transcribe this report.",
        user: "Extract the readings.",
        responseFormat: "json",
        images: [{ mediaType: "image/jpeg", dataBase64: "aW1n" }],
        documents: [{ mediaType: "application/pdf", dataBase64: "cGRm" }],
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // First message is the user turn; its content is now a typed array.
    const content = body.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    const types = content.map((b: { type: string }) => b.type);
    expect(types).toContain("image");
    expect(types).toContain("document");
    // The instruction text comes last, after the data blocks.
    expect(content[content.length - 1].type).toBe("text");
    const image = content.find((b: { type: string }) => b.type === "image");
    expect(image.source).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: "aW1n",
    });
    const doc = content.find((b: { type: string }) => b.type === "document");
    expect(doc.source.media_type).toBe("application/pdf");
    // The assistant `{`-prefill still rides after the array content.
    expect(body.messages[1]).toEqual({ role: "assistant", content: "{" });
  });

  it("keeps a bare-string user content when no vision input is present", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [{ type: "text", text: "{}" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new AnthropicClient({
      apiKey: "sk-ant-x",
      model: "claude-sonnet-4-6",
    });

    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(typeof body.messages[0].content).toBe("string");
  });

  it("throws when content is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ content: [], usage: {} }),
      }),
    );

    const client = new AnthropicClient({
      apiKey: "sk-ant-x",
      model: "claude-3-5-sonnet-latest",
    });

    await expect(
      client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toThrow("Anthropic returned empty content");
  });

  it("maps tools, drops the JSON prefill, parses tool_use + cache reads", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "fetch_glucose",
              input: { window: "last30days" },
            },
          ],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 50,
            output_tokens: 8,
            cache_read_input_tokens: 40,
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new AnthropicClient({
      apiKey: "sk-ant-x",
      model: "claude-sonnet-4-6",
    });

    const result = await client.generateCompletion(
      singleUserTurn({
        system: "s",
        user: "u",
        // Even with responseFormat json, tools must win and drop the prefill.
        responseFormat: "json",
        tools: [
          {
            name: "fetch_glucose",
            description: "Fetch glucose readings",
            parameters: { type: "object", properties: {} },
          },
        ],
        toolChoice: "auto",
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        name: "fetch_glucose",
        description: "Fetch glucose readings",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "auto" });
    // No `{`-prefill assistant turn when tools are present.
    expect(body.messages).toHaveLength(1);
    expect(result.toolCalls).toEqual([
      {
        id: "toolu_1",
        name: "fetch_glucose",
        arguments: JSON.stringify({ window: "last30days" }),
      },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.cachedInputTokens).toBe(40);
  });

  it("derives finishReason from tool_use blocks even on an unexpected stop_reason (M-2)", async () => {
    // Anthropic normally pairs tool_use blocks with stop_reason "tool_use".
    // If it ever returns the blocks under a different (or absent) stop_reason,
    // the loop must still see finishReason "tool_calls" so it executes the tool
    // round instead of surfacing the empty tool_use-only reply as the answer.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          content: [
            {
              type: "tool_use",
              id: "toolu_9",
              name: "fetch_glucose",
              input: { window: "last30days" },
            },
          ],
          // Deliberately NOT "tool_use" — the pre-fix code derived finishReason
          // from this field alone and would have returned undefined here.
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new AnthropicClient({
      apiKey: "sk-ant-x",
      model: "claude-sonnet-4-6",
    });

    const result = await client.generateCompletion(
      singleUserTurn({
        system: "s",
        user: "u",
        tools: [
          {
            name: "fetch_glucose",
            description: "Fetch glucose readings",
            parameters: { type: "object", properties: {} },
          },
        ],
        toolChoice: "auto",
      }),
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.finishReason).toBe("tool_calls");
  });
});
