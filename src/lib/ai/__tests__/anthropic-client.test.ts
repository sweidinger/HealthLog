import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnthropicClient } from "../anthropic-client";

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

    const result = await client.generateCompletion({
      systemPrompt: "You are a doctor.",
      userPrompt: "Analyze this data.",
      temperature: 0.4,
      maxTokens: 800,
    });

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
    // System prompt is a separate top-level field, NOT a message.
    expect(body.system).toBe("You are a doctor.");
    expect(body.messages).toEqual([expect.objectContaining({ role: "user" })]);
    // User message should be wrapped to coerce JSON output.
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

    const result = await client.generateCompletion({
      systemPrompt: "s",
      userPrompt: "u",
      responseFormat: "json",
    });

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

    const result = await client.generateCompletion({
      systemPrompt: "s",
      userPrompt: "u",
    });

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

    await client.generateCompletion({ systemPrompt: "s", userPrompt: "u" });

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
      await client.generateCompletion({
        systemPrompt: "s",
        userPrompt: "u",
      });
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

    await client.generateCompletion({
      systemPrompt: "Transcribe this report.",
      userPrompt: "Extract the readings.",
      responseFormat: "json",
      images: [{ mediaType: "image/jpeg", dataBase64: "aW1n" }],
      documents: [{ mediaType: "application/pdf", dataBase64: "cGRm" }],
    });

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

    await client.generateCompletion({ systemPrompt: "s", userPrompt: "u" });
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
      client.generateCompletion({ systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow("Anthropic returned empty content");
  });
});
