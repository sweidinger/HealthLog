/**
 * Provider-error mapping for /api/insights/generate.
 *
 * v1.4.6 T5 fixed the parse-error path (502 → 422 to keep Cloudflare's
 * HTML-error rewrite from breaking `await res.json()`). The provider-
 * error path still propagated upstream errors (e.g. `OpenAI request
 * failed (401)` for an invalid admin key) to the apiHandler's generic
 * 500 handler. v1.5 now mirrors the v1.4.5 ai/test categorisation:
 *
 *   - 401/403 from the provider → 422 with a readable message
 *   - 5xx from the provider → 503 (transient)
 *   - 429 from the provider → 429 (passthrough, not 5xx)
 *   - any other status → 422 (generic provider-connection failure)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be hoisted before importing the route.
vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1", locale: "en" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        insightsPrivacyMode: "aggregated",
        insightsCachedAt: null,
        insightsCachedText: null,
        locale: "en",
      })),
      update: vi.fn(async () => ({})),
    },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/ai/provider", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/ai/provider")>(
      "@/lib/ai/provider",
    );
  return {
    ...actual,
    resolveProvider: vi.fn(),
  };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/insights/features", () => ({
  extractFeatures: vi.fn(async () => ({ stub: true })),
}));

vi.mock("@/lib/insights/prompt", () => ({
  getInsightsSystemPrompt: vi.fn(() => "system"),
  buildUserPrompt: vi.fn(() => "user"),
}));

vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn(async () => "en"),
}));

import { POST } from "../route";
import { resolveProvider } from "@/lib/ai/provider";

beforeEach(() => {
  vi.clearAllMocks();
});

interface ApiErrorEnvelope {
  data: null;
  error: string;
}

function jsonRequest(body: unknown = {}): Request {
  const text = JSON.stringify(body);
  return new Request("http://localhost/api/insights/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(text.length),
    },
    body: text,
  });
}

function makeProviderThatThrows(
  err: Error & { httpStatus?: number; bodyExcerpt?: string },
) {
  vi.mocked(resolveProvider).mockResolvedValue({
    type: "openai",
    generateCompletion: vi.fn(async () => {
      throw err;
    }),
    // The route only calls generateCompletion; pad the type for TS.
  } as unknown as Awaited<ReturnType<typeof resolveProvider>>);
}

describe("POST /api/insights/generate — provider error mapping", () => {
  it("maps a 401 from the provider to 422 with a readable message", async () => {
    const err = Object.assign(new Error("OpenAI request failed (401)"), {
      httpStatus: 401,
      bodyExcerpt: "{\"error\":{\"code\":\"invalid_api_key\"}}",
    });
    makeProviderThatThrows(err);

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/AI provider rejected/i);
    expect(body.error).toMatch(/API key/i);
  });

  it("maps a 403 from the provider to 422 with the same readable message", async () => {
    const err = Object.assign(new Error("OpenAI request failed (403)"), {
      httpStatus: 403,
    });
    makeProviderThatThrows(err);

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/AI provider rejected/i);
  });

  it("maps a 500 from the provider to 503 with a transient message", async () => {
    const err = Object.assign(new Error("OpenAI request failed (500)"), {
      httpStatus: 500,
    });
    makeProviderThatThrows(err);

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(503);
    const body = (await res.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/temporarily unavailable/i);
  });

  it("maps a 503 from the provider to 503 with a transient message", async () => {
    const err = Object.assign(new Error("OpenAI request failed (503)"), {
      httpStatus: 503,
    });
    makeProviderThatThrows(err);

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(503);
  });

  it("maps a 429 from the provider to 429 (rate-limit passthrough)", async () => {
    const err = Object.assign(new Error("OpenAI request failed (429)"), {
      httpStatus: 429,
    });
    makeProviderThatThrows(err);

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(429);
  });

  it("maps an unknown error (no httpStatus) to 422 with a generic message", async () => {
    makeProviderThatThrows(new Error("network unreachable"));

    const res = await POST(jsonRequest() as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/provider/i);
  });
});
