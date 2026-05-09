import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, CompletionParams, CompletionResult } from "../types";
import {
  AllProvidersFailedError,
  clearLastWorkingProviderCache,
  getLastWorkingProvider,
  isHardProviderFailure,
  runRawCompletionWithFallback,
  runWithFallback,
} from "../provider-runner";

const VALID_RESPONSE = JSON.stringify({
  summary: "ok",
  recommendations: [],
  citations: [],
  warnings: [],
});

interface ScriptedCall {
  ok: boolean;
  content?: string;
  error?: Error & { httpStatus?: number };
}

class ScriptedProvider implements AIProvider {
  readonly type: AIProvider["type"];
  readonly model: string;
  readonly calls: CompletionParams[] = [];
  private readonly script: ScriptedCall[];
  private cursor = 0;

  constructor(opts: {
    type?: AIProvider["type"];
    model?: string;
    script: ScriptedCall[];
  }) {
    this.type = opts.type ?? "local";
    this.model = opts.model ?? "scripted-model";
    this.script = opts.script;
  }

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    this.calls.push(params);
    const step = this.script[Math.min(this.cursor, this.script.length - 1)];
    this.cursor += 1;
    if (!step.ok) {
      throw step.error ?? new Error("scripted-fail");
    }
    return {
      content: step.content ?? VALID_RESPONSE,
      tokensUsed: 1,
      model: this.model,
      providerType: this.type,
    };
  }

  get callCount(): number {
    return this.calls.length;
  }
}

function err(status: number, msg = "boom"): Error & { httpStatus: number } {
  return Object.assign(new Error(msg), { httpStatus: status });
}

beforeEach(() => {
  clearLastWorkingProviderCache();
});

afterEach(() => {
  clearLastWorkingProviderCache();
  vi.useRealTimers();
});

describe("isHardProviderFailure", () => {
  it("flags 401 (auth-class) as hard", () => {
    expect(isHardProviderFailure(err(401))).toBe(true);
  });

  it("flags 403 (auth-class) as hard", () => {
    expect(isHardProviderFailure(err(403))).toBe(true);
  });

  it("flags 5xx (server-class) as hard after retry exhaustion", () => {
    expect(isHardProviderFailure(err(500))).toBe(true);
    expect(isHardProviderFailure(err(503))).toBe(true);
  });

  it("does NOT flag 4xx validation errors (e.g. 422) as hard — those bubble", () => {
    expect(isHardProviderFailure(err(422))).toBe(false);
  });

  it("flags network errors (no httpStatus) as hard", () => {
    expect(isHardProviderFailure(new Error("ECONNRESET"))).toBe(true);
  });

  it("flags zero / sentinel httpStatus as hard (transport-level)", () => {
    expect(isHardProviderFailure(err(0, "ECONNRESET"))).toBe(true);
  });

  it("flags 429 rate-limit as hard so we walk to the next provider rather than starve out", () => {
    expect(isHardProviderFailure(err(429))).toBe(true);
  });
});

describe("runWithFallback — happy path", () => {
  it("returns the parsed response from the first working provider", async () => {
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: true }],
    });
    const result = await runWithFallback({
      userId: "u1",
      providers: [
        { providerType: "codex", instance: codex },
      ],
      params: { systemPrompt: "s", userPrompt: "u" },
    });
    expect(result.parsed.summary).toBe("ok");
    expect(result.raw.providerType).toBe("codex");
    expect(result.fallbackHops).toEqual([]);
    expect(codex.callCount).toBe(1);
  });

  it("attaches the provider type to the outcome for B5e feedback attribution", async () => {
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true }],
    });
    const result = await runWithFallback({
      userId: "u1",
      providers: [
        { providerType: "openai", instance: openai },
      ],
      params: { systemPrompt: "s", userPrompt: "u" },
    });
    expect(result.workingProvider.providerType).toBe("openai");
    expect(result.raw.providerType).toBe("admin-key");
  });
});

describe("runWithFallback — primary fails 401, secondary succeeds", () => {
  it("falls through to the secondary and surfaces the failure reason in the hop log", async () => {
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(401, "OAuth expired") }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true }],
    });
    const result = await runWithFallback({
      userId: "u1",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "openai", instance: openai },
      ],
      params: { systemPrompt: "s", userPrompt: "u" },
    });
    expect(result.parsed.summary).toBe("ok");
    expect(result.workingProvider.providerType).toBe("openai");
    expect(result.fallbackHops).toHaveLength(1);
    expect(result.fallbackHops[0]).toMatchObject({
      providerType: "codex",
      attempt: 1,
    });
    expect(result.fallbackHops[0].failureReason).toMatch(/401/);
  });
});

describe("runWithFallback — all-fail cascade", () => {
  it("throws AllProvidersFailedError when every chain entry fails hard", async () => {
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(0, "ECONNRESET") }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: false, error: err(503, "upstream down") }],
    });
    let caught: unknown;
    try {
      await runWithFallback({
        userId: "u1",
        providers: [
          { providerType: "codex", instance: codex },
          { providerType: "openai", instance: openai },
        ],
        params: { systemPrompt: "s", userPrompt: "u" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AllProvidersFailedError);
    const e = caught as AllProvidersFailedError;
    expect(e.httpStatus).toBe(503);
    expect(e.attempts).toHaveLength(2);
    expect(e.attempts.map((a) => a.providerType)).toEqual([
      "codex",
      "openai",
    ]);
  });
});

describe("runWithFallback — non-hard errors bubble unchanged", () => {
  it("re-throws a 422 schema error from the first provider rather than walking", async () => {
    // schema-mismatch is the wrapper's job, not the runner's. The runner
    // only walks on transport / auth / 5xx — bad JSON from the first
    // provider must still propagate as the wrapper's
    // InsightSchemaError so the user gets the existing 422 surface.
    const breaking = new ScriptedProvider({
      type: "codex",
      // Both wrapper attempts return invalid JSON → wrapper raises
      // InsightSchemaError(422). The runner does not walk to provider
      // 2 because that error is not a "hard provider failure".
      script: [{ ok: true, content: "not-json" }, { ok: true, content: "still-not-json" }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true }],
    });
    let caught: unknown;
    try {
      await runWithFallback({
        userId: "u1",
        providers: [
          { providerType: "codex", instance: breaking },
          { providerType: "openai", instance: openai },
        ],
        params: { systemPrompt: "s", userPrompt: "u" },
      });
    } catch (e) {
      caught = e;
    }
    // Wrapper threw — fallback runner should NOT have escalated to
    // openai because schema-mismatch is not a hard provider failure.
    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe("InsightSchemaError");
    expect(openai.callCount).toBe(0);
  });
});

describe("runWithFallback — last-working cache", () => {
  it("caches the working provider so the next call starts there", async () => {
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(401) }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true }, { ok: true }],
    });

    // First call: codex fails, openai succeeds.
    await runWithFallback({
      userId: "u-cache",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "openai", instance: openai },
      ],
      params: { systemPrompt: "s", userPrompt: "u" },
    });

    expect(getLastWorkingProvider("u-cache")).toBe("openai");

    // Second call: cache reorders so openai is tried first; codex is
    // never re-invoked even though it appears first in the input chain.
    await runWithFallback({
      userId: "u-cache",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "openai", instance: openai },
      ],
      params: { systemPrompt: "s", userPrompt: "u" },
    });

    // codex was called exactly once (first call's failure); the cache
    // skipped it on the second call.
    expect(codex.callCount).toBe(1);
    expect(openai.callCount).toBe(2);
  });

  it("expires the cache after 1 hour", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-05-09T12:00:00Z");
    vi.setSystemTime(t0);

    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(401) }, { ok: true }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true }],
    });

    // First call: codex fails, openai succeeds, cache = openai.
    await runWithFallback({
      userId: "u-ttl",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "openai", instance: openai },
      ],
      params: { systemPrompt: "s", userPrompt: "u" },
    });
    expect(getLastWorkingProvider("u-ttl")).toBe("openai");

    // 61 minutes later — cache should have expired.
    vi.setSystemTime(new Date(t0.getTime() + 61 * 60_000));
    expect(getLastWorkingProvider("u-ttl")).toBeNull();

    // Next call walks the original priority order again (codex first,
    // and this time codex's second scripted entry succeeds).
    await runWithFallback({
      userId: "u-ttl",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "openai", instance: openai },
      ],
      params: { systemPrompt: "s", userPrompt: "u" },
    });
    expect(getLastWorkingProvider("u-ttl")).toBe("codex");
  });

  it("clearLastWorkingProviderCache wipes the cache", async () => {
    const ok = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true }],
    });
    await runWithFallback({
      userId: "u-clear",
      providers: [{ providerType: "openai", instance: ok }],
      params: { systemPrompt: "s", userPrompt: "u" },
    });
    expect(getLastWorkingProvider("u-clear")).toBe("openai");
    clearLastWorkingProviderCache();
    expect(getLastWorkingProvider("u-clear")).toBeNull();
  });
});

describe("runRawCompletionWithFallback — legacy route shim", () => {
  it("returns the first non-hard-failure response", async () => {
    const codex = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(503) }],
    });
    const openai = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: true, content: "{ \"legacy\": true }" }],
    });
    const result = await runRawCompletionWithFallback({
      userId: "u-raw",
      providers: [
        { providerType: "codex", instance: codex },
        { providerType: "admin-openai", instance: openai },
      ],
      params: { systemPrompt: "s", userPrompt: "u" },
    });
    expect(result.result.content).toBe('{ "legacy": true }');
    expect(result.workingProvider.providerType).toBe("admin-openai");
    expect(result.fallbackHops).toHaveLength(1);
    expect(result.fallbackHops[0].providerType).toBe("codex");
  });

  it("throws AllProvidersFailedError when every entry fails hard", async () => {
    const a = new ScriptedProvider({
      type: "codex",
      script: [{ ok: false, error: err(401) }],
    });
    const b = new ScriptedProvider({
      type: "admin-key",
      script: [{ ok: false, error: err(503) }],
    });
    let caught: unknown;
    try {
      await runRawCompletionWithFallback({
        userId: "u-raw-allfail",
        providers: [
          { providerType: "codex", instance: a },
          { providerType: "admin-openai", instance: b },
        ],
        params: { systemPrompt: "s", userPrompt: "u" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AllProvidersFailedError);
    expect((caught as AllProvidersFailedError).attempts).toHaveLength(2);
  });
});

describe("runWithFallback — empty input", () => {
  it("throws AllProvidersFailedError with httpStatus 422 when zero providers configured", async () => {
    let caught: unknown;
    try {
      await runWithFallback({
        userId: "u-empty",
        providers: [],
        params: { systemPrompt: "s", userPrompt: "u" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AllProvidersFailedError);
    expect((caught as AllProvidersFailedError).httpStatus).toBe(422);
  });
});
