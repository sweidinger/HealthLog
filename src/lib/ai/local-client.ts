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
 * v1.22 (#89) — absolute backstop for the streaming path. The real ceiling is
 * the per-idle-gap timer (`CompletionParams.timeoutMs`); this only stops a
 * server that streams forever from pinning a worker. Ten minutes is far beyond
 * any legitimate single Coach turn.
 */
const STREAM_ABSOLUTE_CEILING_MS = 10 * 60_000;

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

  /**
   * Build the shared request shape (url + headers + body) for both the
   * buffered and the streaming paths. `stream` adds the OpenAI-compatible
   * `stream: true` + `stream_options.include_usage` so the final SSE chunk
   * carries the token total.
   */
  private buildRequest(
    params: CompletionParams,
    stream: boolean,
  ): { url: string; headers: Record<string, string>; body: string } {
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

    const body = JSON.stringify({
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
      // v1.22 (#89) — streaming opt-in. `stream_options.include_usage` asks
      // OpenAI-compatible servers (vLLM / LM Studio / exo) to append a final
      // chunk carrying the usage block so the token footer survives streaming.
      ...(stream
        ? { stream: true, stream_options: { include_usage: true } }
        : {}),
    });

    return { url, headers, body };
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    const { url, headers, body } = this.buildRequest(params, false);

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
        body,
      },
      // v1.20.1 — compose the caller's cancel signal (Coach SSE disconnect) so
      // a mid-generation abort tears the upstream call down early.
      {
        // v1.21.5 — honour the caller's per-request timeout override; default 60 s.
        timeoutMs: params.timeoutMs ?? 60_000,
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

  /**
   * v1.22 (#89) — true token streaming over the OpenAI-compatible
   * `stream: true` wire. POSTs with `stream: true`, reads the SSE response body
   * incrementally, and emits each `choices[0].delta.content` chunk through
   * `onDelta` as it arrives. The returned `CompletionResult` carries the FULL
   * assembled reply so every downstream guard still runs on the complete text.
   *
   * Timeout model: per-IDLE-gap, not whole-call. An idle timer (`timeoutMs`,
   * default 60 s) is armed before the request and reset on every chunk, so a
   * slow first token (an MLX/exo server loading the model) and a long total
   * generation are both fine as long as bytes keep flowing. A genuine stall
   * (no byte for the idle window) aborts the upstream. A generous absolute
   * ceiling backstops a server that streams forever.
   *
   * Graceful fallback: a server that rejects `stream: true` (non-2xx), or
   * ignores it and returns a buffered JSON body, or has no readable stream
   * body, degrades to the non-streaming {@link generateCompletion} path. The
   * Coach gets real tokens where the backend supports streaming and identical
   * behaviour where it does not.
   */
  async generateCompletionStream(
    params: CompletionParams,
    onDelta: (delta: string) => void,
  ): Promise<CompletionResult> {
    const { url, headers, body } = this.buildRequest(params, true);
    const allowPrivate = isLocalAiHostAllowed(url);

    // Idle controller: aborts the upstream when no chunk arrives within the
    // per-idle window. Composed with the caller's cancel signal so a client
    // disconnect still tears the call down immediately.
    const idle = new AbortController();
    const idleMs = params.timeoutMs ?? 60_000;
    const signal = params.signal
      ? AbortSignal.any([params.signal, idle.signal])
      : idle.signal;

    let res: Response;
    try {
      res = await safeFetch(
        url,
        { method: "POST", headers, body },
        {
          // Absolute backstop only — the per-idle timer below is the real
          // ceiling. A server that streams forever still cannot pin a worker.
          timeoutMs: STREAM_ABSOLUTE_CEILING_MS,
          requirePublicHost: !allowPrivate,
          signal,
        },
      );
    } catch {
      // Network / private-host / abort before the stream opened → fall back to
      // the buffered path, which surfaces the structured error the chain runner
      // understands (or succeeds on a server that simply doesn't stream).
      return this.generateCompletion(params);
    }

    if (!res.ok) {
      // The server rejected the streaming request (some servers 400 on
      // `stream`/`stream_options`). Retry once on the buffered path so a
      // non-streaming server still works and surfaces its real status.
      return this.generateCompletion(params);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !res.body) {
      // The server ignored the stream flag and returned a buffered completion
      // (or there is no readable body). Parse it like the non-streaming path
      // rather than paying a second round-trip.
      const json = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      } | null;
      const buffered = json?.choices?.[0]?.message?.content;
      if (!buffered) {
        const err = new Error("Local AI returned empty content");
        Object.assign(err, {
          httpStatus: 0,
          kind: "empty_response",
          upstream: "local",
        });
        throw err;
      }
      onDelta(buffered);
      return {
        content: buffered,
        tokensUsed: json?.usage?.total_tokens ?? null,
        model: this.config.model,
        providerType: "local",
      };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let content = "";
    let tokensUsed: number | null = null;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), idleMs);
    };
    armIdle();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        sseBuffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; each frame is one or more
        // `data:` lines. Split on newlines and process complete lines, keeping
        // any partial trailing line in the buffer.
        let nl: number;
        while ((nl = sseBuffer.indexOf("\n")) !== -1) {
          const line = sseBuffer.slice(0, nl).trim();
          sseBuffer = sseBuffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice("data:".length).trim();
          if (!payload || payload === "[DONE]") continue;
          let chunk: {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { total_tokens?: number };
          };
          try {
            chunk = JSON.parse(payload);
          } catch {
            // A malformed chunk line is skipped, not fatal — keep reading.
            continue;
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            onDelta(delta);
          }
          if (typeof chunk.usage?.total_tokens === "number") {
            tokensUsed = chunk.usage.total_tokens;
          }
        }
      }
    } catch (err) {
      // An abort (idle stall or client disconnect) mid-stream: if we already
      // assembled usable prose, return it — the user got a real (if clipped)
      // answer and every guard still runs on it. With nothing assembled, this
      // is a hard transport failure for the chain runner to cascade on.
      if (!content) {
        const e = new Error("Local AI stream failed before any content");
        Object.assign(e, {
          httpStatus: 0,
          kind: "stream_aborted",
          upstream: "local",
          cause: err,
        });
        throw e;
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      reader.cancel().catch(() => {});
    }

    if (!content) {
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
      tokensUsed,
      model: this.config.model,
      providerType: "local",
    };
  }
}
