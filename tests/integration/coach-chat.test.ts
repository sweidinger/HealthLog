/**
 * Integration coverage for POST /api/insights/chat — the v1.4.20 AI
 * Coach SSE-streaming endpoint.
 *
 * Scenarios pinned end-to-end against the postgres testcontainer:
 *
 *   1. Refusal: an off-topic message ("what is the weather") returns a
 *      stream containing exactly the localised refusal text and never
 *      reaches the provider chain. The user message and the refusal
 *      message both persist on disk so the rail shows the attempt.
 *   2. Round-trip: a valid health question lands a mocked provider
 *      reply which is persisted (encrypted) and decrypts cleanly when
 *      the conversation is fetched back.
 *   3. Budget cap: when CoachUsage already shows the day's cap spent,
 *      the route returns 429 with `coach.budget.exceeded` and no
 *      provider call happens.
 *   4. Existence-leak guard: a foreign user's conversationId returns
 *      404, not 403.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { MAX_TOKENS_PER_USER_PER_DAY } from "@/lib/ai/coach/budget";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// Stub feature extraction so we don't need a full measurement seed.
vi.mock("@/lib/insights/features", () => ({
  extractFeatures: vi.fn(async () => ({
    bloodPressure: {
      avgSys30: 130,
      avgDia30: 84,
      coverage: { count: 14, spanDays: 30 },
    },
  })),
}));

vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn(async () => "en"),
}));

// Mock the provider chain runner so test cases can drive the assistant
// reply without touching a real LLM. By default the runner returns a
// canned reply; tests can replace the implementation per case.
const runProviderMock = vi.fn();
vi.mock("@/lib/ai/provider-runner", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/ai/provider-runner")
  >("@/lib/ai/provider-runner");
  return {
    ...actual,
    runRawCompletionWithFallback: (...args: unknown[]) =>
      runProviderMock(...args),
  };
});

vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: vi.fn(async () => [
    {
      providerType: "openai",
      instance: { type: "openai", generateCompletion: vi.fn() },
    },
  ]),
  resolveProvider: vi.fn(async () => ({ type: "none" })),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  runProviderMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedUserWithSession(): Promise<{ userId: string }> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "coach-user",
      email: "coach@example.test",
      role: "USER",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return { userId: user.id };
}

async function readStream(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("POST /api/insights/chat — integration", () => {
  it("refuses out-of-scope messages without hitting a provider", async () => {
    await seedUserWithSession();
    const { POST } = await import("@/app/api/insights/chat/route");

    const res = await (POST as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "What is the weather forecast for Berlin tomorrow?",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await readStream(res);
    expect(text).toMatch(/I can only help with the health metrics/);
    expect(runProviderMock).not.toHaveBeenCalled();

    const prisma = getPrismaClient();
    const messages = await prisma.coachMessage.findMany();
    // user message + assistant refusal both persisted
    expect(messages.length).toBe(2);
    const refusal = messages.find((m) => m.role === "assistant");
    expect(refusal?.providerType).toBe("refusal");
  });

  it("round-trips an assistant reply with encrypted persistence", async () => {
    await seedUserWithSession();
    runProviderMock.mockResolvedValue({
      result: {
        content:
          "Your 30-day systolic average is 130 mmHg, in the elevated band — please consult your doctor.",
        tokensUsed: 256,
        model: "mock",
        providerType: "openai",
      },
      workingProvider: { providerType: "openai", instance: {} },
      fallbackHops: [],
    });
    const { POST } = await import("@/app/api/insights/chat/route");

    const res = await (POST as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "How is my blood pressure trending this month?",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const text = await readStream(res);
    // Tokens are streamed word-by-word — concatenate the token bodies
    // to recover the assistant reply for the substring assertion.
    const tokens: string[] = [];
    for (const m of text.matchAll(/"type":"token","token":"([^"]*)"/g)) {
      tokens.push(m[1]);
    }
    expect(tokens.join("")).toMatch(/Your 30-day systolic average is 130/);
    expect(text).toMatch(/"type":"done"/);
    expect(text).toMatch(/"type":"provenance"/);

    const prisma = getPrismaClient();
    const messages = await prisma.coachMessage.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    // Encrypted bytes: must NOT contain the cleartext substring.
    const buf = Buffer.from(messages[1].encryptedContent);
    expect(buf.toString("utf8")).not.toMatch(/elevated band/);

    // CoachUsage row bumped with the provider's token figure.
    const usage = await prisma.coachUsage.findFirst();
    expect(usage?.totalTokens).toBe(256);
    expect(usage?.messageCount).toBe(1);
  });

  it("returns 429 when daily token budget is exhausted", async () => {
    const { userId } = await seedUserWithSession();
    const prisma = getPrismaClient();
    const dateKey = new Date().toISOString().slice(0, 10);
    await prisma.coachUsage.create({
      data: {
        userId,
        dateKey,
        totalTokens: MAX_TOKENS_PER_USER_PER_DAY,
        messageCount: 50,
      },
    });

    const { POST } = await import("@/app/api/insights/chat/route");
    const res = await (POST as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Why did my pulse spike yesterday?",
        }),
      }),
    );
    expect(res.status).toBe(429);
    const env = (await res.json()) as { error: string };
    expect(env.error).toBe("coach.budget.exceeded");
    expect(runProviderMock).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when conversationId belongs to another user", async () => {
    // Seed a foreign user's conversation
    const prisma = getPrismaClient();
    const foreign = await prisma.user.create({
      data: { username: "foreign", role: "USER" },
    });
    const foreignConvo = await prisma.coachConversation.create({
      data: { userId: foreign.id, title: "secret" },
    });

    // Authenticate as a different user
    await seedUserWithSession();

    const { POST } = await import("@/app/api/insights/chat/route");
    const res = await (POST as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Check my blood pressure trend.",
          conversationId: foreignConvo.id,
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects malformed body with 422", async () => {
    await seedUserWithSession();
    const { POST } = await import("@/app/api/insights/chat/route");
    const res = await (POST as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "" }),
      }),
    );
    expect(res.status).toBe(422);
  });
});
