import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexClient } from "../codex-client";

describe("CodexClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends request to codex responses endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"summary":"ok"}' }],
            },
          ],
          usage: { total_tokens: 50 },
        }),
    });
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
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer test-token");
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
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: '{"test":true}' }],
              },
            ],
            usage: { total_tokens: 10 },
          }),
      });
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
