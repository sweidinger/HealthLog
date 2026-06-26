import { safeFetch } from "@/lib/safe-fetch";
import { isLocalAiHostAllowed } from "./local-host-allowlist";
import type {
  AIProvider,
  AiMessage,
  CompletionParams,
  CompletionResult,
} from "./types";
import { buildOpenAIMessages } from "./openai-wire";

interface LocalClientConfig {
  apiKey?: string | null;
  model: string;
  baseUrl: string;
}

const STRICT_JSON_PREFIX =
  "Return strict JSON only, no markdown, no commentary.\n\n";

/**
 * Prepend the strict-JSON instruction to the FIRST user turn's text. Local
 * model templates respect an in-message instruction better than the
 * `response_format` flag (which many reject). Mirrors the pre-refactor
 * behaviour, which prepended to the single user prompt.
 */
function withStrictJsonPrefix(messages: AiMessage[]): AiMessage[] {
  const idx = messages.findIndex((m) => m.role === "user");
  if (idx === -1) return messages;
  const out = [...messages];
  const target = out[idx];
  if (typeof target.content === "string") {
    out[idx] = { ...target, content: `${STRICT_JSON_PREFIX}${target.content}` };
  } else {
    // Vision parts: prepend a leading text part with the instruction.
    out[idx] = {
      ...target,
      content: [{ type: "text", text: STRICT_JSON_PREFIX }, ...target.content],
    };
  }
  return out;
}

/**
 * Talks to OpenAI-compatible local servers (Ollama, LocalAI, LM Studio,
 * vLLM, …). Same wire format as OpenAI but without
 * `response_format: { type: "json_object" }` — many local models reject the
 * field outright. Instead we prepend a strict-JSON instruction to the user
 * message, which is what most local model templates respect.
 *
 * v1.20.0 — tool-calling DEGRADES silently here: most local servers reject an
 * unknown `tools` field, so the client never forwards it (capability flag
 * below). F1's tool loop must therefore tolerate a provider that never returns
 * `toolCalls` and answer from base context. Prompt-caching, where the local
 * server supports it (vLLM / Ollama prefix cache), is transparent — no flag,
 * no harm.
 */
export class LocalOpenAICompatibleClient implements AIProvider {
  readonly type = "local" as const;
  /** Local servers commonly reject an unknown `tools` field — never send it. */
  readonly supportsTools = false;
  private config: LocalClientConfig;

  constructor(config: LocalClientConfig) {
    this.config = config;
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    // Some local servers (LM Studio with auth, vLLM behind a proxy) require a
    // bearer; Ollama does not. Send the header only when an actual key is set.
    const trimmedKey = this.config.apiKey?.trim();
    if (trimmedKey) {
      headers.Authorization = `Bearer ${trimmedKey}`;
    }

    // System turn first, then the conversation turns (with the strict-JSON
    // instruction folded into the first user turn). Vision parts (Lab-OCR)
    // become the OpenAI-compatible `image_url` content array that llava /
    // llama-vision models accept over the same endpoint. The image is framed
    // as untrusted DATA by the system prompt.
    const messages = buildOpenAIMessages(
      params.system,
      withStrictJsonPrefix(params.messages),
    );

    // safeFetch defaults: no redirect-follow (the local endpoint is the
    // most exploitable on this surface — a user-controlled baseUrl that
    // 302s to 169.254.169.254 would otherwise leak the bearer on the
    // redirected hop into the visible error envelope via `bodyExcerpt`)
    // and an explicit 60 s ceiling so a stalled GPU or tar-pit proxy
    // can't pin a worker indefinitely. `requirePublicHost` gates the
    // baseUrl against the input-time SSRF allowlist; the dispatcher
    // pin (issue #217) extends the same flag with a connect-time
    // resolved-IP check to also defeat DNS rebinding. Operators who
    // legitimately point at a self-hosted Ollama / LM Studio on an
    // RFC1918 address opt in via `ALLOW_LOCAL_AI_PRIVATE_HOSTS` — either the
    // legacy `=true` (any private host) or a comma-separated host allowlist
    // (only those hostnames). Enforced at write-time in /api/user/ai-provider
    // too. v1.18.7 (SECURITY LOW) — the binary flag became a host allowlist.
    const allowPrivate = isLocalAiHostAllowed(url);
    const res = await safeFetch(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: params.temperature ?? 0.3,
          max_tokens: params.maxTokens ?? 1000,
          // Deterministic seed for reproducible reference output. Ollama +
          // most OpenAI-compatible local servers honour it; servers that
          // ignore it simply disregard the field. Omitted when unset.
          ...(params.seed !== undefined ? { seed: params.seed } : {}),
          // v1.18.7 — Ollama's native structured-output switch. The JSON
          // surfaces opt in via `responseFormat: "json"`; it cuts the
          // first-pass JSON-failure rate that the fence-stripping safety net
          // otherwise has to catch. The Coach (prose) leaves it unset.
          ...(params.responseFormat === "json" ? { format: "json" } : {}),
        }),
      },
      // v1.20.1 — compose the caller's cancel signal (Coach SSE disconnect) so
      // a mid-generation abort tears the upstream call down early.
      {
        timeoutMs: 60_000,
        requirePublicHost: !allowPrivate,
        signal: params.signal,
      },
    );

    if (!res.ok) {
      // Mirror the openai-client structured-error pattern. Local endpoints
      // also commonly leak bearer tokens in error envelopes (proxies), so
      // strip anything that looks like a key before logging.
      const rawBody = await res.text().catch(() => "");
      const bodyExcerpt = rawBody
        .slice(0, 500)
        .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***redacted***")
        .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer ***redacted***");
      const err = new Error(`Local AI request failed (${res.status})`);
      Object.assign(err, {
        httpStatus: res.status,
        upstream: "local",
        model: this.config.model,
        baseUrl: this.config.baseUrl,
        bodyExcerpt,
      });
      throw err;
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      // v1.20.1 — sentinel httpStatus + kind so the chain classifier can tell
      // an empty 200-OK reply apart from a transport failure. Cascade unchanged
      // (`status <= 0` is already a hard failure).
      const err = new Error("Local AI returned empty content");
      Object.assign(err, {
        httpStatus: 0,
        kind: "empty_response",
        upstream: "local",
      });
      throw err;
    }

    return {
      content,
      tokensUsed: json.usage?.total_tokens ?? null,
      model: this.config.model,
      providerType: "local",
    };
  }
}
