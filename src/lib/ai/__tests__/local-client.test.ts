import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalOpenAICompatibleClient } from "../local-client";
import { singleUserTurn } from "../types";

describe("LocalOpenAICompatibleClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // These tests cover the operator-opt-in path (LM Studio / Ollama on
    // an RFC1918 host). The safeFetch wrapper enforces the SSRF guard
    // unless the operator explicitly accepts a private host.
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("targets the configured baseUrl + /chat/completions", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"summary":"local"}' } }],
          usage: { total_tokens: 17 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://localhost:11434/v1",
    });

    const result = await client.generateCompletion(
      singleUserTurn({ system: "system", user: "user-input" }),
    );

    expect(result.content).toBe('{"summary":"local"}');
    expect(result.tokensUsed).toBe(17);
    expect(result.model).toBe("llama3:8b");
    expect(result.providerType).toBe("local");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");

    const body = JSON.parse(init.body);
    expect(body.model).toBe("llama3:8b");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: "system" });
    // User message should be prefixed with the strict-JSON instruction.
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("user-input");
    expect(body.messages[1].content.toLowerCase()).toContain("json");

    // CRUCIAL: do not send response_format because many local servers reject it.
    expect(body).not.toHaveProperty("response_format");
    // No JSON opt-in → no `format` field.
    expect(body).not.toHaveProperty("format");
  });

  it("sends Ollama `format: json` only when the caller opts into JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"summary":"x"}' } }],
          usage: { total_tokens: 3 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://localhost:11434/v1",
    });

    await client.generateCompletion(
      singleUserTurn({
        system: "s",
        user: "u",
        responseFormat: "json",
        seed: 99,
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.format).toBe("json");
    expect(body.seed).toBe(99);
  });

  it("omits Authorization header when no API key is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "{}" } }],
          usage: { total_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: "",
      model: "phi3",
      baseUrl: "http://localhost:11434/v1",
    });

    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    const init = mockFetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("sends Bearer Authorization when an API key is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "{}" } }],
          usage: { total_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: "lm-studio-secret",
      model: "phi3",
      baseUrl: "http://192.168.1.20:1234/v1",
    });

    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    const init = mockFetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer lm-studio-secret");
  });

  it("captures structured error fields and redacts bearer tokens on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () =>
          Promise.resolve(
            "upstream rejected: Bearer sk-localabcdef12345 hit /v1",
          ),
      }),
    );

    const client = new LocalOpenAICompatibleClient({
      apiKey: "sk-local-test",
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
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
      baseUrl?: string;
    };
    expect(err.message).toBe("Local AI request failed (500)");
    expect(err.httpStatus).toBe(500);
    expect(err.upstream).toBe("local");
    expect(err.baseUrl).toBe("http://localhost:11434/v1");
    expect(err.bodyExcerpt).toContain("Bearer ***redacted***");
    expect(err.bodyExcerpt).not.toContain("sk-localabcdef12345");
  });

  it("throws when content is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ choices: [{ message: { content: "" } }] }),
      }),
    );

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });

    await expect(
      client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toThrow("Local AI returned empty content");
  });

  // ── v1.22 (#89) — true token streaming ──────────────────────────
  function sseStreamResponse(chunks: string[]) {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (k: string) => (k === "content-type" ? "text/event-stream" : null),
      },
      body,
    };
  }

  it("streams token deltas over stream:true and assembles the full reply", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        sseStreamResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":42}}\n\n',
          "data: [DONE]\n\n",
        ]),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://localhost:11434/v1",
    });

    const deltas: string[] = [];
    const result = await client.generateCompletionStream(
      singleUserTurn({ system: "s", user: "u" }),
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(["Hel", "lo", " world"]);
    expect(result.content).toBe("Hello world");
    expect(result.tokensUsed).toBe(42);
    expect(result.providerType).toBe("local");

    // The request opted into streaming.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("falls back to the buffered body when the server ignores stream:true", async () => {
    // 200 OK but a normal JSON completion (not event-stream).
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      body: null,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "buffered reply" } }],
          usage: { total_tokens: 7 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });

    const deltas: string[] = [];
    const result = await client.generateCompletionStream(
      singleUserTurn({ system: "s", user: "u" }),
      (d) => deltas.push(d),
    );

    expect(result.content).toBe("buffered reply");
    expect(result.tokensUsed).toBe(7);
    // The whole buffered body is emitted as one delta.
    expect(deltas).toEqual(["buffered reply"]);
  });

  it("falls back to non-streaming generateCompletion when streaming is rejected", async () => {
    const mockFetch = vi
      .fn()
      // 1st call: the streaming attempt is rejected (server 400s on stream).
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: { get: () => "application/json" },
        text: () => Promise.resolve("stream not supported"),
      })
      // 2nd call: the buffered retry succeeds.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "non-stream reply" } }],
            usage: { total_tokens: 5 },
          }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });

    const result = await client.generateCompletionStream(
      singleUserTurn({ system: "s", user: "u" }),
      () => {},
    );

    expect(result.content).toBe("non-stream reply");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The retry was the buffered (non-streaming) request shape.
    const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(retryBody).not.toHaveProperty("stream");
  });

  it("degrades tools silently — never forwards a `tools` field", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "{}" } }],
          usage: { total_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(client.supportsTools).toBe(false);

    await client.generateCompletion(
      singleUserTurn({
        system: "s",
        user: "u",
        tools: [{ name: "t", description: "d", parameters: {} }],
        toolChoice: "auto",
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });
});
