import type { AIProvider, CompletionParams, CompletionResult } from "./types";

const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_MODEL = "gpt-5.3-codex";

interface CodexClientConfig {
  accessToken: string;
  onTokenRefresh: () => Promise<string>;
}

export class CodexClient implements AIProvider {
  readonly type = "codex" as const;
  private accessToken: string;
  private onTokenRefresh: () => Promise<string>;

  constructor(config: CodexClientConfig) {
    this.accessToken = config.accessToken;
    this.onTokenRefresh = config.onTokenRefresh;
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const firstAttempt = await this.doRequest(params);

    if (firstAttempt.status === 401) {
      this.accessToken = await this.onTokenRefresh();
      const retryAttempt = await this.doRequest(params);
      if (!retryAttempt.ok) {
        throw await this.buildUpstreamError(
          retryAttempt,
          "Codex request failed after token refresh",
        );
      }
      return this.parseResponse(retryAttempt);
    }

    if (!firstAttempt.ok) {
      throw await this.buildUpstreamError(firstAttempt, "Codex request failed");
    }

    return this.parseResponse(firstAttempt);
  }

  /**
   * Build a structured error from a non-OK upstream response. Mirrors the
   * pattern used in `OpenAIClient.generateCompletion` so logs and Glitchtip
   * issues for both providers carry the same fields (httpStatus, upstream,
   * model, bodyExcerpt). The body excerpt is truncated to 500 chars and any
   * `sk-…` / `Bearer …` token is masked before it reaches log shipping.
   */
  private async buildUpstreamError(
    res: Response,
    message: string,
  ): Promise<Error> {
    const rawBody = await res.text().catch(() => "");
    const bodyExcerpt = rawBody
      .slice(0, 500)
      .replace(/sk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, "sk-***redacted***")
      .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer ***redacted***");
    const err = new Error(`${message} (${res.status})`);
    Object.assign(err, {
      httpStatus: res.status,
      upstream: "codex",
      model: CODEX_MODEL,
      bodyExcerpt,
    });
    return err;
  }

  private async doRequest(params: CompletionParams): Promise<Response> {
    // The chatgpt.com/backend-api/codex/responses endpoint expects the
    // OpenAI Responses API shape: `input` is an array of typed message
    // items, NOT a raw string. The Codex CLI's `ResponsesApiRequest`
    // (`codex-rs/codex-api/src/common.rs`) is the canonical definition.
    return fetch(CODEX_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        model: CODEX_MODEL,
        instructions: params.systemPrompt,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: params.userPrompt }],
          },
        ],
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        // Codex backend rejects sync responses with
        // `Stream must be set to true`. We have to consume SSE.
        stream: true,
      }),
    });
  }

  /**
   * Consume the Codex SSE stream and assemble the final assistant
   * message. The Codex backend emits OpenAI-Responses-API events:
   *
   *   event: response.output_text.delta
   *   data: { "delta": "Hello" }
   *
   *   event: response.output_item.done
   *   data: { "type": "message", "role": "assistant",
   *           "content": [{ "type": "output_text", "text": "Hello world" }] }
   *
   *   event: response.completed
   *   data: { "type": "response.completed",
   *           "response": { "id": "...", "usage": { "total_tokens": 123 } } }
   *
   * Strategy:
   *   - Prefer the assembled text in `response.output_item.done` (any
   *     `message` item with `assistant` role and `output_text` content).
   *     This avoids re-stitching `delta` chunks ourselves.
   *   - Fall back to concatenating all `output_text.delta` chunks if no
   *     output_item.done arrived before the stream ended.
   *   - Pick up token usage from `response.completed` when present.
   *   - Throw on `response.error` events with the upstream message.
   */
  private async parseResponse(res: Response): Promise<CompletionResult> {
    if (!res.body) {
      throw new Error("Codex returned no response body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assembledText = "";
    let deltaText = "";
    let tokensUsed: number | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE messages are separated by a blank line (\n\n).
        let separator: number;
        while ((separator = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);

          const dataLine = rawEvent
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let parsed: {
            type?: string;
            delta?: string;
            item?: {
              type?: string;
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
            };
            response?: { usage?: { total_tokens?: number } };
            error?: { message?: string };
          };
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          if (parsed.type === "response.output_text.delta" && parsed.delta) {
            deltaText += parsed.delta;
            continue;
          }

          if (parsed.type === "response.output_item.done" && parsed.item) {
            const item = parsed.item;
            if (item.type === "message" && item.role === "assistant") {
              const text = item.content
                ?.filter((c) => c.type === "output_text" && c.text)
                .map((c) => c.text!)
                .join("");
              if (text) assembledText += text;
            }
            continue;
          }

          if (parsed.type === "response.completed") {
            tokensUsed = parsed.response?.usage?.total_tokens ?? null;
            continue;
          }

          if (parsed.type === "response.error" || parsed.type === "error") {
            const message =
              parsed.error?.message ?? "Codex stream returned an error event";
            throw new Error(message);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const content = assembledText || deltaText;
    if (!content) {
      throw new Error("Codex returned empty content");
    }

    return {
      content,
      tokensUsed,
      model: CODEX_MODEL,
      providerType: "codex",
    };
  }
}
