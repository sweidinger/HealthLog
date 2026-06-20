import { safeFetch } from "@/lib/safe-fetch";
import type { AIProvider, CompletionParams, CompletionResult } from "./types";

/**
 * v1.18.9 — Anthropic Messages API content blocks. The text-only path sends a
 * bare string; the vision path (Lab-OCR) sends an array of typed blocks. The
 * uploaded image / PDF is framed strictly as DATA to transcribe by the system
 * prompt — never as instructions (prompt-injection backstop is the human
 * review screen downstream).
 */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    };

/**
 * Build the user-turn content for a vision request: the image / document
 * blocks first (so the model reads the report before the instruction), then
 * the JSON-wrapped instruction text. Returns null when there is nothing to
 * attach, so the caller keeps the bare-string text path unchanged.
 */
function buildVisionContent(
  params: CompletionParams,
  text: string,
): AnthropicContentBlock[] | null {
  const images = params.images ?? [];
  const documents = params.documents ?? [];
  if (images.length === 0 && documents.length === 0) return null;

  const blocks: AnthropicContentBlock[] = [];
  for (const img of images) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType,
        data: img.dataBase64,
      },
    });
  }
  for (const doc of documents) {
    blocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: doc.dataBase64,
      },
    });
  }
  blocks.push({ type: "text", text });
  return blocks;
}

interface AnthropicClientConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Wrap the user prompt so Claude reliably emits valid JSON.
 * Anthropic's Messages API has no `response_format: json_object` knob; the
 * documented best-practice is an explicit instruction in the user message.
 */
function wrapForJson(userPrompt: string): string {
  return `${userPrompt}\n\nRespond only with valid JSON matching the requested schema. Do not include any prose, markdown fences, or explanation outside the JSON object.`;
}

export class AnthropicClient implements AIProvider {
  readonly type = "anthropic" as const;
  private config: AnthropicClientConfig;

  constructor(config: AnthropicClientConfig) {
    this.config = config;
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const baseUrl = (this.config.baseUrl ?? DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    );
    const url = `${baseUrl}/messages`;

    // v1.18.9 — fold vision inputs (Lab-OCR) into the user turn when present.
    // The text-only path keeps a bare-string content; the vision path sends a
    // typed content array (image / document blocks + the instruction text).
    // The `{`-prefill JSON trick works after either shape.
    const wrappedText = wrapForJson(params.userPrompt);
    const visionContent = buildVisionContent(params, wrappedText);
    const userContent: AnthropicContentBlock[] | string =
      visionContent ?? wrappedText;

    const res = await safeFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        // NOTE: Anthropic's Messages API has no `seed` parameter, so
        // `params.seed` is intentionally not forwarded here — output on this
        // provider is non-deterministic regardless of the pinned seed.
        //
        // v1.18.7 — JSON-reliability prefill. For the structured surfaces
        // (`responseFormat: "json"`) we seed the assistant turn with a bare
        // `{`. Anthropic continues from that token, so the first emitted
        // character is already inside a JSON object — this drops the
        // first-pass "prose preamble before the JSON" failure the
        // fence-stripping net otherwise has to catch. We re-prepend the `{`
        // to the returned text below so the caller sees a complete object.
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: params.maxTokens ?? 1000,
          temperature: params.temperature ?? 0.3,
          system: params.systemPrompt,
          messages:
            params.responseFormat === "json"
              ? [
                  { role: "user", content: userContent },
                  { role: "assistant", content: "{" },
                ]
              : [{ role: "user", content: userContent }],
        }),
      },
      // 60 s ceiling — see openai-client.ts for the rationale.
      // v1.11.2 — base URL is user/admin-overridable; pin the connect-time DNS
      // check so a private/metadata address is rejected (SSRF/rebinding).
      { timeoutMs: 60_000, requirePublicHost: true },
    );

    if (!res.ok) {
      // Mirror the openai-client body-capture so 4xx/5xx upstream incidents
      // (model-not-found, overloaded, rate limit) are diagnosable from logs
      // instead of surfacing as an opaque "Anthropic request failed (5xx)".
      // Strip anything that looks like an Anthropic API key from the excerpt
      // before logging.
      const rawBody = await res.text().catch(() => "");
      const bodyExcerpt = rawBody
        .slice(0, 500)
        .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***redacted***")
        .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer ***redacted***");
      const err = new Error(`Anthropic request failed (${res.status})`);
      Object.assign(err, {
        httpStatus: res.status,
        upstream: "anthropic",
        model: this.config.model,
        bodyExcerpt,
      });
      throw err;
    }

    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const textBlock = json.content?.find((c) => c.type === "text");
    const rawText = textBlock?.text;

    if (!rawText) {
      throw new Error("Anthropic returned empty content");
    }

    // When we prefilled the assistant turn with `{`, the model continues
    // from there and its returned text omits that leading brace — re-prepend
    // it so the caller parses a complete object. Guard against a model that
    // (rarely) echoes the prefill itself.
    const content =
      params.responseFormat === "json" && !rawText.trimStart().startsWith("{")
        ? `{${rawText}`
        : rawText;

    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;
    const tokensUsed = inputTokens + outputTokens || null;

    return {
      content,
      tokensUsed,
      model: this.config.model,
      providerType: "anthropic",
    };
  }
}
