import { safeFetch } from "@/lib/safe-fetch";
import type { AIProvider, CompletionParams, CompletionResult } from "./types";
import {
  buildOpenAIMessages,
  buildOpenAITools,
  mapFinishReason,
  parseCachedTokens,
  parseOpenAIToolCalls,
  type OpenAIResponseJson,
} from "./openai-wire";

interface OpenAIClientConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  /**
   * Override the provider tag used in logs and analytics. Defaults to
   * "admin-key". The Codex flow uses the same OpenAI API but the key
   * was obtained via the token-exchange grant against a ChatGPT
   * subscription — for billing and observability we want that path
   * to log as "codex" instead.
   */
  providerType?: "admin-key" | "codex";
}

type OpenAIProviderType = "admin-key" | "codex";

export class OpenAIClient implements AIProvider {
  readonly type: OpenAIProviderType;
  private config: OpenAIClientConfig;

  constructor(config: OpenAIClientConfig) {
    this.config = config;
    this.type = config.providerType ?? "admin-key";
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    // System turn first (the stable cache prefix — OpenAI prefix-caches a
    // byte-identical ≥1024-token prefix automatically, no API flag), then the
    // conversation turns mapped 1:1. Vision parts (Lab-OCR) become the
    // multimodal `image_url` content array `gpt-4o`-class models accept. The
    // image is framed as untrusted DATA by the system prompt.
    const messages = buildOpenAIMessages(params.system, params.messages);

    // v1.20.0 — tool plumbing. The defs map onto the OpenAI `function` tool
    // wire; F1 supplies real defs and consumes the parsed `toolCalls`. No F4
    // call site sets `tools`, so the text-only body is unchanged.
    const tools =
      params.tools && params.tools.length > 0
        ? buildOpenAITools(params.tools)
        : undefined;

    const res = await safeFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: params.temperature ?? 0.3,
          max_tokens: params.maxTokens ?? 1000,
          response_format: { type: "json_object" },
          // Deterministic seed for reproducible reference output; omitted
          // (undefined → dropped by JSON.stringify) when the caller does
          // not pin one (e.g. the seedless daily-briefing re-roll).
          ...(params.seed !== undefined ? { seed: params.seed } : {}),
          ...(tools ? { tools } : {}),
          ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
        }),
      },
      // 60 s ceiling so a tar-pit upstream cannot pin a worker
      // indefinitely. Real completions land well inside this budget.
      // v1.11.2 — the base URL is user/admin-overridable (BYO gateway), so pin
      // the connect-time DNS check: a base URL resolving to a private/metadata
      // address is rejected, closing the SSRF/rebinding surface.
      { timeoutMs: 60_000, requirePublicHost: true },
    );

    if (!res.ok) {
      // Pull as much of the body as we can so upstream incidents (OpenAI 5xx,
      // model-not-found, quota exceeded) are diagnosable from logs instead of
      // surfacing as an opaque "OpenAI request failed (500)". Strip anything
      // that looks like an API key from the excerpt before logging.
      const rawBody = await res.text().catch(() => "");
      const bodyExcerpt = rawBody
        .slice(0, 500)
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***redacted***")
        .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer ***redacted***");
      const err = new Error(`OpenAI request failed (${res.status})`);
      // Keep the body in a structured field rather than the message so
      // Error.message stays short and the excerpt lands in dedicated log
      // fields (bodyExcerpt) that can be filtered/truncated centrally.
      Object.assign(err, {
        httpStatus: res.status,
        upstream: "openai",
        model: this.config.model,
        bodyExcerpt,
      });
      throw err;
    }

    const json = (await res.json()) as OpenAIResponseJson;
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    const toolCalls = parseOpenAIToolCalls(choice);

    // A reply with tool calls and no prose is valid (F1 tool loop); only an
    // empty reply with neither content NOR tool calls is an error.
    if (!content && !toolCalls) {
      throw new Error("OpenAI returned empty content");
    }

    return {
      content: content ?? "",
      tokensUsed: json.usage?.total_tokens ?? null,
      cachedInputTokens: parseCachedTokens(json),
      model: this.config.model,
      providerType: this.type,
      ...(toolCalls ? { toolCalls } : {}),
      finishReason: mapFinishReason(choice?.finish_reason),
    };
  }
}
