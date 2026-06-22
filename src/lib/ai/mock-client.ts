import type {
  AIProvider,
  AiToolCall,
  CompletionParams,
  CompletionResult,
} from "./types";

/**
 * Deterministic mock AI provider for tests.
 *
 * Phase C1 (v1.4.15): provider abstraction review. The route layer at
 * `/api/insights/generate` only depends on the `AIProvider` interface.
 * Real providers (Codex / OpenAI / Anthropic / Local) talk to upstream
 * services that cannot be exercised cheaply in CI; this implementation
 * returns canned `CompletionResult`s so tests covering the interface
 * contract (parsing, retry-once, citation enforcement, schema gating)
 * never hit the network.
 *
 * The mock is exported from `src/lib/ai/` so any test can import it,
 * but it is NOT registered in `resolveProvider()` — the production
 * path must never reach it.
 */
export interface MockAIProviderOptions {
  /** Provider tag returned in `CompletionResult.providerType`. Defaults to "local". */
  providerType?: "codex" | "admin-key" | "anthropic" | "local";
  /** Slug returned in `CompletionResult.model`. Defaults to "mock-model". */
  model?: string;
  /**
   * Either a single canned response that is returned on every call,
   * or an array consumed in order — when the array is exhausted the
   * last element is repeated. Each element is the JSON-serialised body
   * of the assistant message (i.e. what `result.content` will hold).
   */
  responses?: string | string[];
  /**
   * If set, every call rejects with this error instead of returning a
   * response. Useful for fallback / retry tests.
   */
  rejectWith?: Error;
  /**
   * Optional `tokensUsed` figure stamped onto the result (single value
   * or per-call array, same semantics as `responses`).
   */
  tokensUsed?: number | number[] | null;
  /**
   * v1.20.0 — tool calls echoed on the result (single set replayed every
   * call, or an array consumed per-call). Lets F1 exercise its tool loop
   * against the mock without a live provider.
   */
  toolCalls?: AiToolCall[] | AiToolCall[][];
  /** v1.20.0 — finishReason echoed on the result. Defaults to undefined. */
  finishReason?: CompletionResult["finishReason"];
  /** v1.20.0 — cachedInputTokens echoed on the result. Defaults to null. */
  cachedInputTokens?: number | null;
}

/** Type guard: a per-call array of tool-call sets. */
function isToolCallMatrix(
  v: AiToolCall[] | AiToolCall[][] | undefined,
): v is AiToolCall[][] {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
}

// Conforms to v1.4.15 strict `aiInsightResponseSchema`. Tests that need
// the legacy v1.4.14 rich shape opt in via `responses: [...]`.
const DEFAULT_RESPONSE = JSON.stringify({
  summary: "mock",
  recommendations: [],
  citations: [],
  warnings: [],
});

export class MockAIProvider implements AIProvider {
  readonly type: "codex" | "admin-key" | "anthropic" | "local";
  /** The mock can echo tool calls, so it advertises tool support. */
  readonly supportsTools = true;
  readonly calls: CompletionParams[] = [];
  private readonly responses: string[];
  private readonly tokens: Array<number | null>;
  private readonly toolCalls: AiToolCall[][] | undefined;
  private readonly finishReason: CompletionResult["finishReason"];
  private readonly cachedInputTokens: number | null;
  private readonly model: string;
  private readonly rejectWith: Error | undefined;
  private callIdx = 0;

  constructor(opts: MockAIProviderOptions = {}) {
    this.type = opts.providerType ?? "local";
    this.model = opts.model ?? "mock-model";
    this.rejectWith = opts.rejectWith;
    this.finishReason = opts.finishReason;
    this.cachedInputTokens = opts.cachedInputTokens ?? null;
    if (isToolCallMatrix(opts.toolCalls)) {
      this.toolCalls = opts.toolCalls;
    } else if (Array.isArray(opts.toolCalls)) {
      this.toolCalls = [opts.toolCalls];
    } else {
      this.toolCalls = undefined;
    }
    if (Array.isArray(opts.responses)) {
      this.responses =
        opts.responses.length > 0 ? opts.responses : [DEFAULT_RESPONSE];
    } else if (typeof opts.responses === "string") {
      this.responses = [opts.responses];
    } else {
      this.responses = [DEFAULT_RESPONSE];
    }
    if (Array.isArray(opts.tokensUsed)) {
      this.tokens = opts.tokensUsed;
    } else if (opts.tokensUsed === undefined) {
      this.tokens = [42];
    } else {
      this.tokens = [opts.tokensUsed];
    }
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    this.calls.push(params);
    if (this.rejectWith) {
      throw this.rejectWith;
    }
    const idx = Math.min(this.callIdx, this.responses.length - 1);
    const tokIdx = Math.min(this.callIdx, this.tokens.length - 1);
    const toolCalls = this.toolCalls
      ? this.toolCalls[Math.min(this.callIdx, this.toolCalls.length - 1)]
      : undefined;
    this.callIdx++;
    return {
      content: this.responses[idx],
      tokensUsed: this.tokens[tokIdx] ?? null,
      cachedInputTokens: this.cachedInputTokens,
      model: this.model,
      providerType: this.type,
      ...(toolCalls ? { toolCalls } : {}),
      finishReason: this.finishReason,
    };
  }

  /** Number of times `generateCompletion` was invoked. */
  get callCount(): number {
    return this.calls.length;
  }
}
