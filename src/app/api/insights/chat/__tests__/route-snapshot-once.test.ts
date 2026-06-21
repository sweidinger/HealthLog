import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.19.1 (C4) — token-efficiency contract. The full SNAPSHOT block (the
 * expensive grounding prefix) must ride the prompt only ONCE per conversation:
 * on the first turn (no prior turns on disk). A follow-up turn that still sits
 * inside the verbatim history window must send a short pointer in place of the
 * figures, so typing one word no longer re-ships ~15k tokens of snapshot. This
 * suite captures the `userPrompt` handed to the provider runner on each turn
 * and pins both the first-turn-full and follow-up-cheap shapes.
 */

const SNAPSHOT_JSON = '{"bp":{"aggregate":{"mean":128}}}';
const GROUNDING = "REFERENCE RANGES\nBP optimal < 120/80.";

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
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
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
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: vi.fn(async () => [
    { providerType: "admin-openai", instance: {} },
  ]),
  resolveProvider: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  assertConsentForChain: vi.fn(async () => undefined),
}));
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

const { fetchConversationWithMessages } = vi.hoisted(() => ({
  fetchConversationWithMessages: vi.fn(),
}));
vi.mock("@/lib/ai/coach/persistence", () => ({
  appendMessage: vi.fn(async () => ({ id: "m1" })),
  createConversation: vi.fn(async () => ({ id: "c1" })),
  fetchConversationWithMessages,
  listConversations: vi.fn(),
}));
vi.mock("@/lib/ai/coach/coach-memory-shared", () => ({
  enqueueCoachMemoryRefresh: vi.fn(),
}));
vi.mock("@/lib/ai/coach/facts", () => ({
  storeDeterministicFacts: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-06-21"),
  reserveBudget: vi.fn(async () => ({ allowed: true, reserved: 1500 })),
  reconcileSpend: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/coach/refusal", () => ({
  detectRefusal: vi.fn(() => ({ refuse: false })),
}));
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
    provenance: { windows: ["last30days"], metrics: ["bp"] },
    referenceGrounding: GROUNDING,
  })),
}));
vi.mock("@/lib/ai/coach/keyvalues", () => ({
  parseKeyValuesSentinel: vi.fn(() => ({
    prose: "Your BP looks stable.",
    keyValues: [],
    malformed: false,
    malformedEntries: [],
  })),
}));
vi.mock("@/lib/ai/coach/suggest-reminder", () => ({
  parseSuggestReminder: vi.fn(() => ({ prose: "Your BP looks stable." })),
}));
vi.mock("@/lib/ai/coach/suggest-gate", () => ({ gateSuggestion: vi.fn() }));
vi.mock("@/lib/validations/coach-prefs", () => ({
  parseCoachPrefs: vi.fn(() => ({ defaultWindow: undefined })),
  DEFAULT_REMINDER_SUGGESTION_PREFS: {},
}));
vi.mock("@/lib/sse/create-stream", () => ({
  // Drain the producer synchronously so the handler completes; we only care
  // about the provider call args, not the wire frames.
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

function lastUserPrompt(): string {
  const calls = runRawCompletionWithFallback.mock.calls as unknown as Array<
    [{ params: { userPrompt: string } }]
  >;
  const last = calls[calls.length - 1];
  return last[0].params.userPrompt;
}

describe("coach chat — snapshot sent once per conversation (C4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runRawCompletionWithFallback.mockResolvedValue({
      result: { content: "Your BP looks stable.", tokensUsed: 42, model: "m" },
      workingProvider: { providerType: "admin-openai" },
    });
  });

  it("ships the full SNAPSHOT + grounding on the first turn", async () => {
    await post(chatReq({ message: "How is my BP?" }));
    const prompt = lastUserPrompt();
    expect(prompt).toContain(SNAPSHOT_JSON);
    expect(prompt).toContain(GROUNDING);
  });

  it("does NOT re-ship the snapshot figures on a follow-up turn", async () => {
    fetchConversationWithMessages.mockResolvedValue({
      id: "c1",
      summary: null,
      messages: [
        { role: "user", content: "How is my BP?" },
        { role: "assistant", content: "Your BP looks stable." },
      ],
    });

    await post(chatReq({ conversationId: "c1", message: "High?" }));
    const prompt = lastUserPrompt();
    // The expensive figures + grounding must be gone …
    expect(prompt).not.toContain(SNAPSHOT_JSON);
    expect(prompt).not.toContain(GROUNDING);
    // … replaced by the cheap pointer back to the earlier snapshot, and the
    // prior turns still ride the transcript so grounding is preserved.
    expect(prompt).toContain("provided earlier in this conversation");
    expect(prompt).toContain("Your BP looks stable.");
  });
});
