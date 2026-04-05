import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIClient } from "../openai-client";

describe("OpenAIClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct request format", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"summary":"test"}' } }],
          usage: { total_tokens: 42 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    const result = await client.generateCompletion({
      systemPrompt: "You are a doctor.",
      userPrompt: "Analyze this data.",
    });

    expect(result.content).toBe('{"summary":"test"}');
    expect(result.tokensUsed).toBe(42);
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.providerType).toBe("admin-key");

    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toHaveLength(2);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve("rate limited"),
      }),
    );

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    await expect(
      client.generateCompletion({ systemPrompt: "test", userPrompt: "test" }),
    ).rejects.toThrow("OpenAI request failed (429)");
  });

  it("uses custom base URL for OpenRouter", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"test":true}' } }],
          usage: { total_tokens: 10 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-or-test",
      model: "openai/gpt-4o-mini",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    await client.generateCompletion({ systemPrompt: "test", userPrompt: "test" });

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });
});
