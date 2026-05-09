import { randomUUID } from "node:crypto";
import type { AIProvider, CompletionParams, CompletionResult } from "./types";

/**
 * Codex backend client — talks to `chatgpt.com/backend-api/codex/responses`
 * via the OpenAI Responses API (SSE streaming, ChatGPT-Account-ID
 * header, OAuth Bearer auth). Implemented against the spec at
 * `docs/codex-protocol-spec.md`, which mirrors the official `openai/codex`
 * CLI.
 *
 * Required headers:
 *   - `Authorization: Bearer <oauth-access-token>`
 *   - `ChatGPT-Account-ID: <chatgpt_account_id JWT claim>`
 *   - `Content-Type: application/json`
 *   - `Accept: text/event-stream`
 *   - `originator`, `User-Agent`, `session_id`, `thread_id`
 *
 * Response is always SSE (server rejects `stream: false` with 400).
 */

const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/**
 * Model slug for the ChatGPT-account auth path.
 *
 * The ChatGPT/Codex backend has a tight allow-list of slugs accepted for
 * subscription auth. As of 2026-05 the bundled Codex models in the
 * official `openai/codex` client are `gpt-5.5` / `gpt-5.4` /
 * `gpt-5.4-mini` / `gpt-5.3-codex` / `gpt-5.2`; `gpt-5` and `gpt-5-codex`
 * are both rejected on this auth path with a 400:
 *
 *   {"detail":"The 'gpt-5' model is not supported when using Codex with
 *   a ChatGPT account."}
 *
 * `gpt-5.3-codex` is the codex-optimized slug available on Plus/Pro
 * plans (per `codex-rs/models-manager/models.json` `available_in_plans`)
 * and accepts our HealthLog "summarize health metrics" prompts without
 * issue (verified live 2026-05-09).
 *
 * The server safety-routes when needed and reports the actual routed
 * model in the `OpenAI-Model` response header — we trust that header
 * for downstream logging.
 *
 * Operators on a different plan can override via the `CODEX_MODEL` env
 * var on apps01 (e.g. `gpt-5.5` on Free, `gpt-5.4` on Plus/Pro).
 */
const CODEX_MODEL = process.env.CODEX_MODEL?.trim() || "gpt-5.3-codex";

const ORIGINATOR = "healthlog";
const USER_AGENT = "HealthLog/1.0 (+https://healthlog.bombeck.io)";

interface CodexClientConfig {
  accessToken: string;
  accountId: string;
  onTokenRefresh: () => Promise<{ accessToken: string; accountId: string }>;
}

export class CodexClient implements AIProvider {
  readonly type = "codex" as const;
  private accessToken: string;
  private accountId: string;
  private onTokenRefresh: () => Promise<{
    accessToken: string;
    accountId: string;
  }>;

  constructor(config: CodexClientConfig) {
    this.accessToken = config.accessToken;
    this.accountId = config.accountId;
    this.onTokenRefresh = config.onTokenRefresh;
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const firstAttempt = await this.doRequest(params);

    if (firstAttempt.status === 401) {
      const fresh = await this.onTokenRefresh();
      this.accessToken = fresh.accessToken;
      this.accountId = fresh.accountId;
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
    const sessionId = randomUUID();
    const threadId = randomUUID();
    return fetch(CODEX_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${this.accessToken}`,
        "ChatGPT-Account-ID": this.accountId,
        originator: ORIGINATOR,
        "User-Agent": USER_AGENT,
        session_id: sessionId,
        "session-id": sessionId,
        thread_id: threadId,
        "thread-id": threadId,
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
        // Reasoning is required-but-nullable on the wire. We don't ask
        // for reasoning summaries — emit `null` so the JSON has the
        // field present and the server stops complaining about a
        // missing key (it returned 400 in earlier iterations).
        reasoning: null,
        store: false,
        stream: true,
        // Required field; empty array when not asking for reasoning.
        include: [],
      }),
    });
  }

  /**
   * Consume the Codex SSE stream and assemble the final assistant
   * message. Event types per the spec:
   *
   *   - `response.output_item.done` — final assembled item; an
   *     assistant `Message` carries the canonical reply in
   *     `item.content[].text`.
   *   - `response.output_text.delta` — incremental chunks; fallback
   *     when no done event arrives.
   *   - `response.completed` — terminal; carries `usage.total_tokens`.
   *   - `response.failed` / `response.incomplete` — terminal errors.
   *
   * Reasoning deltas (`response.reasoning_*.delta`) are deliberately
   * NOT folded into the visible text — they belong to a separate
   * channel.
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
    let serverModel: string | null = null;

    // The server reports the actual routed model in the OpenAI-Model
    // response header — useful when safety-routing kicks in.
    const headerModel = res.headers.get("OpenAI-Model");
    if (headerModel) serverModel = headerModel;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separator: number;
        while ((separator = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);

          const dataLine = rawEvent
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;

          let parsed: {
            type?: string;
            delta?: string;
            item?: {
              type?: string;
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
            };
            response?: {
              usage?: { total_tokens?: number };
              error?: { code?: string; message?: string };
              incomplete_details?: { reason?: string };
            };
            error?: { code?: string; message?: string };
          };
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          switch (parsed.type) {
            case "response.output_text.delta": {
              if (parsed.delta) deltaText += parsed.delta;
              break;
            }
            case "response.output_item.done": {
              const item = parsed.item;
              if (item?.type === "message" && item.role === "assistant") {
                const text = item.content
                  ?.filter((c) => c.type === "output_text" && c.text)
                  .map((c) => c.text!)
                  .join("");
                if (text) assembledText += text;
              }
              break;
            }
            case "response.completed": {
              tokensUsed = parsed.response?.usage?.total_tokens ?? null;
              break;
            }
            case "response.failed": {
              const err = parsed.response?.error;
              const message =
                err?.message ?? "Codex stream returned response.failed";
              const e = new Error(message);
              Object.assign(e, {
                upstream: "codex",
                errorCode: err?.code ?? null,
                model: serverModel ?? CODEX_MODEL,
              });
              throw e;
            }
            case "response.incomplete": {
              const reason =
                parsed.response?.incomplete_details?.reason ??
                "incomplete response";
              throw new Error(`Codex stream incomplete: ${reason}`);
            }
            case "error":
            case "response.error": {
              const message =
                parsed.error?.message ?? "Codex stream returned an error event";
              throw new Error(message);
            }
            default:
              // Unknown event types are tolerated and ignored, same
              // as the official client.
              break;
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
      model: serverModel ?? CODEX_MODEL,
      providerType: "codex",
    };
  }
}
