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

  async generateCompletion(params: CompletionParams): Promise<CompletionResult> {
    const firstAttempt = await this.doRequest(params);

    if (firstAttempt.status === 401) {
      this.accessToken = await this.onTokenRefresh();
      const retryAttempt = await this.doRequest(params);
      if (!retryAttempt.ok) {
        throw new Error(`Codex request failed after token refresh (${retryAttempt.status})`);
      }
      return this.parseResponse(retryAttempt);
    }

    if (!firstAttempt.ok) {
      const body = await firstAttempt.text();
      throw new Error(`Codex request failed (${firstAttempt.status}): ${body}`);
    }

    return this.parseResponse(firstAttempt);
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

    const messageOutput = json.output?.find(
      (o: any) => o.type === "message",
    );
    const textContent = messageOutput?.content?.find(
      (c: any) => c.type === "output_text",
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
