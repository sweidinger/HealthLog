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
    return fetch(CODEX_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        model: CODEX_MODEL,
        instructions: params.systemPrompt,
        input: params.userPrompt,
        stream: false,
      }),
    });
  }

  private async parseResponse(res: Response): Promise<CompletionResult> {
    const json = await res.json();

    const messageOutput = (
      json.output as Array<{
        type: string;
        content?: Array<{ type: string; text?: string }>;
      }>
    )?.find((o) => o.type === "message");
    const textContent = messageOutput?.content?.find(
      (c) => c.type === "output_text",
    );

    if (!textContent?.text) {
      throw new Error("Codex returned empty content");
    }

    return {
      content: textContent.text,
      tokensUsed: json.usage?.total_tokens ?? null,
      model: CODEX_MODEL,
      providerType: "codex",
    };
  }
}
