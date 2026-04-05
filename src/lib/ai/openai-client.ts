import type { AIProvider, CompletionParams, CompletionResult } from "./types";

interface OpenAIClientConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export class OpenAIClient implements AIProvider {
  readonly type = "admin-key" as const;
  private config: OpenAIClientConfig;

  constructor(config: OpenAIClientConfig) {
    this.config = config;
  }

  async generateCompletion(params: CompletionParams): Promise<CompletionResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userPrompt },
        ],
        temperature: params.temperature ?? 0.3,
        max_tokens: params.maxTokens ?? 1000,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI request failed (${res.status}): ${body}`);
    }

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("OpenAI returned empty content");
    }

    return {
      content,
      tokensUsed: json.usage?.total_tokens ?? null,
      model: this.config.model,
      providerType: "admin-key",
    };
  }
}
