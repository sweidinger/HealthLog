import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIClient } from "../openai-client";
import { singleUserTurn } from "../types";

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

    const result = await client.generateCompletion(
      singleUserTurn({
        system: "You are a doctor.",
        user: "Analyze this data.",
      }),
    );

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
    // No seed passed → field omitted from the body entirely.
    expect(body).not.toHaveProperty("seed");
  });

  it("threads a deterministic seed onto the request body when supplied", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"summary":"x"}' } }],
          usage: { total_tokens: 5 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    });

    await client.generateCompletion(
      singleUserTurn({ system: "test", user: "test", seed: 1234 }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.seed).toBe(1234);
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
      client.generateCompletion(
        singleUserTurn({ system: "test", user: "test" }),
      ),
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

    await client.generateCompletion(
      singleUserTurn({ system: "test", user: "test" }),
    );

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("maps tool defs onto the function wire and parses tool_calls", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    function: {
                      name: "fetch_glucose",
                      arguments: '{"window":"last30days"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            total_tokens: 12,
            prompt_tokens_details: { cached_tokens: 8 },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
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

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "fetch_glucose",
          description: "Fetch glucose readings",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        name: "fetch_glucose",
        arguments: '{"window":"last30days"}',
      },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.cachedInputTokens).toBe(8);
  });

  it("folds image parts into the multimodal content array", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"rows":[]}' } }],
          usage: { total_tokens: 3 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new OpenAIClient({
      apiKey: "sk-test",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
    });

    await client.generateCompletion(
      singleUserTurn({
        system: "s",
        user: "transcribe",
        images: [{ mediaType: "image/png", dataBase64: "AAAA" }],
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const userTurn = body.messages[1];
    expect(userTurn.role).toBe("user");
    // Text-first, then image (matches the pre-refactor OpenAI vision wire).
    expect(userTurn.content[0]).toEqual({ type: "text", text: "transcribe" });
    expect(userTurn.content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });
});
