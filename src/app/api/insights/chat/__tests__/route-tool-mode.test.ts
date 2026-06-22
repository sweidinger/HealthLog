import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.20.0 (F1) — Coach tool-retrieval routing contract.
 *
 *  - When every provider in the chain supports tools, the route runs the tool
 *    loop with a base context (DATA INVENTORY, NOT the snapshot figures), and
 *    persists the tool trace onto provenance.
 *  - When any provider lacks tool support, the route falls back to the legacy
 *    snapshot-stuffing single completion verbatim.
 *  - The inbound gates (rate limit, refusal, consent, budget reservation) all
 *    fire BEFORE the loop in both modes.
 */

const SNAPSHOT_JSON = '{"bp":{"aggregate":{"mean":128}}}';

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));
vi.mock("@/lib/feature-flags", () => ({
  requireAssistantSurface: vi.fn(async () => undefined),
}));
vi.mock("@/lib/api-response", () => ({
  apiError: (error: string, status: number) => ({ data: null, error, status }),
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ coachPrefsJson: null })) },
    coachConversation: { findFirst: vi.fn(async () => ({ id: "c1" })) },
  },
}));

const { checkRateLimit } = vi.hoisted(() => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit }));
vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn(async () => "en"),
}));

const { runRawCompletionWithFallback } = vi.hoisted(() => ({
  runRawCompletionWithFallback: vi.fn(),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runRawCompletionWithFallback,
}));

const { resolveProviderChain } = vi.hoisted(() => ({
  resolveProviderChain: vi.fn(),
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain,
  resolveProvider: vi.fn(),
}));

const { assertConsentForChain } = vi.hoisted(() => ({
  assertConsentForChain: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/consent-guard", () => ({ assertConsentForChain }));
vi.mock("@/lib/ai/prompts/insight-generator", () => ({ PROMPT_VERSION: "x" }));
vi.mock("@/lib/ai/ai-budgets", () => ({
  AI_BUDGETS: { coach: { maxTokens: 1500, temperature: 0.4 } },
}));

vi.mock("@/lib/ai/coach/types", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/coach/types")>(
    "@/lib/ai/coach/types",
  );
  return actual;
});

vi.mock("@/lib/ai/coach/persistence", () => ({
  appendMessage: vi.fn(async () => ({ id: "m1" })),
  createConversation: vi.fn(async () => ({ id: "c1" })),
  fetchConversationWithMessages: vi.fn(),
  listConversations: vi.fn(),
}));
vi.mock("@/lib/ai/coach/coach-memory-shared", () => ({
  enqueueCoachMemoryRefresh: vi.fn(),
}));
vi.mock("@/lib/ai/coach/facts", () => ({
  storeDeterministicFacts: vi.fn(async () => undefined),
}));

const { reserveBudget, reconcileSpend } = vi.hoisted(() => ({
  reserveBudget: vi.fn<
    () => Promise<{
      allowed: boolean;
      reserved: number;
      totalAfter?: number;
    }>
  >(async () => ({ allowed: true, reserved: 3000 })),
  reconcileSpend: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-06-21"),
  reserveBudget,
  reconcileSpend,
}));

const { detectRefusal } = vi.hoisted(() => ({
  detectRefusal: vi.fn(() => ({ refuse: false })),
}));
vi.mock("@/lib/ai/coach/refusal", () => ({ detectRefusal }));
vi.mock("@/lib/ai/coach/outbound-guard", () => ({
  screenCoachReply: vi.fn(() => ({ block: false })),
  coachOutboundFallback: vi.fn(() => "fallback"),
}));
vi.mock("@/lib/ai/coach/system-prompt", () => ({
  getCoachSystemPrompt: vi.fn(() => "SYSTEM"),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextTextForUser: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/coach/snapshot", () => ({
  buildCoachSnapshot: vi.fn(async () => ({
    snapshotJson: SNAPSHOT_JSON,
    sections: { bloodPressure: { aggregate: { mean: 128 } } },
    provenance: { windows: ["last30days"], metrics: ["bp"] },
    referenceGrounding: "REFERENCE RANGES",
  })),
}));

// Tool-module surface — stub the inventory + loop so we assert routing only.
const { buildCoachDataInventory, renderDataInventory, runCoachToolLoop } =
  vi.hoisted(() => ({
    buildCoachDataInventory: vi.fn(async () => ({
      entries: [],
      restMode: false,
      cycleEnabled: false,
      window: "last30days",
    })),
    renderDataInventory: vi.fn(
      () => "DATA INVENTORY\n- blood pressure: present",
    ),
    runCoachToolLoop: vi.fn(async () => ({
      result: { content: "Your BP is steady.", tokensUsed: 80, model: "m" },
      workingProviderType: "anthropic",
      totalTokens: 80,
      rounds: 2,
      toolTrace: [{ name: "get_metric_series", present: true }],
    })),
  }));
vi.mock("@/lib/ai/coach/tools", () => ({
  COACH_TOOL_DEFS: [{ name: "get_metric_series" }],
  MAX_ROUNDS: 2,
  buildCoachDataInventory,
  renderDataInventory,
  buildToolModeAddendum: vi.fn(() => "TOOL ADDENDUM"),
  runCoachToolLoop,
}));

vi.mock("@/lib/ai/coach/keyvalues", () => ({
  parseKeyValuesSentinel: vi.fn(() => ({
    prose: "Your BP is steady.",
    keyValues: [],
    malformed: false,
    malformedEntries: [],
  })),
}));
vi.mock("@/lib/ai/coach/suggest-reminder", () => ({
  parseSuggestReminder: vi.fn(() => ({ prose: "Your BP is steady." })),
}));
vi.mock("@/lib/ai/coach/suggest-gate", () => ({ gateSuggestion: vi.fn() }));
vi.mock("@/lib/validations/coach-prefs", () => ({
  parseCoachPrefs: vi.fn(() => ({ defaultWindow: undefined })),
  DEFAULT_REMINDER_SUGGESTION_PREFS: {},
}));

const { appendMessage } = await import("@/lib/ai/coach/persistence");

vi.mock("@/lib/sse/create-stream", () => ({
  createSseStream: (
    producer: (c: {
      signal: { aborted: boolean };
      enqueue: () => void;
    }) => void | Promise<void>,
  ) => {
    void Promise.resolve(
      producer({ signal: { aborted: true }, enqueue: () => {} }),
    );
    return new ReadableStream();
  },
}));

import { POST } from "../route";

const post = POST as unknown as (req: Request) => Promise<Response>;

function chatReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/insights/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("coach chat — tool-mode routing (F1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveBudget.mockResolvedValue({ allowed: true, reserved: 3000 });
    detectRefusal.mockReturnValue({ refuse: false });
    checkRateLimit.mockResolvedValue({ allowed: true });
    assertConsentForChain.mockResolvedValue(undefined);
  });

  it("runs the tool loop (not the snapshot path) when the chain supports tools", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} }, // no supportsTools=false ⇒ tools on
    ]);
    await post(chatReq({ message: "How is my BP?" }));

    expect(runCoachToolLoop).toHaveBeenCalledTimes(1);
    expect(runRawCompletionWithFallback).not.toHaveBeenCalled();
    // The base context carries the inventory, NOT the snapshot figures.
    const loopArgs = (runCoachToolLoop.mock.calls[0] as unknown[])[0] as {
      messages: Array<{ content: string }>;
    };
    const userContent = loopArgs.messages[0].content;
    expect(userContent).toContain("DATA INVENTORY");
    expect(userContent).not.toContain(SNAPSHOT_JSON);
  });

  it("reserves the multi-round budget in tool mode", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    await post(chatReq({ message: "How is my BP?" }));
    // maxTokens (1500) × MAX_ROUNDS (2).
    expect(reserveBudget).toHaveBeenCalledWith("u1", 3000, "2026-06-21");
  });

  it("persists the tool trace onto provenance", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    await post(chatReq({ message: "How is my BP?" }));
    const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const assistantCall = calls.find(
      (c) => (c[0] as { role: string }).role === "assistant",
    );
    expect(
      (assistantCall?.[0] as { metricSource: { toolCalls?: unknown } })
        .metricSource.toolCalls,
    ).toEqual([{ name: "get_metric_series", present: true }]);
  });

  it("falls back to the snapshot-stuffing path when a provider lacks tools", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
      { providerType: "local", instance: { supportsTools: false } },
    ]);
    runRawCompletionWithFallback.mockResolvedValue({
      result: { content: "Your BP is steady.", tokensUsed: 42, model: "m" },
      workingProvider: { providerType: "anthropic" },
    });
    await post(chatReq({ message: "How is my BP?" }));

    expect(runCoachToolLoop).not.toHaveBeenCalled();
    expect(runRawCompletionWithFallback).toHaveBeenCalledTimes(1);
    // Single-round budget reservation in the fallback path.
    expect(reserveBudget).toHaveBeenCalledWith("u1", 1500, "2026-06-21");
    // The legacy path ships the snapshot figures in the user turn.
    const params = (
      (runRawCompletionWithFallback.mock.calls[0] as unknown[])[0] as {
        params: { messages: Array<{ content: string }> };
      }
    ).params;
    expect(params.messages[0].content).toContain(SNAPSHOT_JSON);
  });

  it("fires the inbound gates BEFORE the loop (consent throws ⇒ no loop)", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    assertConsentForChain.mockRejectedValue(new Error("consent.ai.required"));
    await expect(post(chatReq({ message: "How is my BP?" }))).rejects.toThrow(
      "consent.ai.required",
    );
    expect(runCoachToolLoop).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
  });

  it("refuses over-budget before entering the loop", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    reserveBudget.mockResolvedValue({
      allowed: false,
      reserved: 3000,
      totalAfter: 99999,
    });
    await post(chatReq({ message: "How is my BP?" }));
    expect(runCoachToolLoop).not.toHaveBeenCalled();
  });
});
