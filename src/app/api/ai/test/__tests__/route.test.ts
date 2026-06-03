import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be hoisted before importing the route.
vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/ai/provider", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/ai/provider")>(
      "@/lib/ai/provider",
    );
  return {
    ...actual,
    resolveProviderForTest: vi.fn(),
  };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { POST } from "../route";
import { resolveProviderForTest } from "@/lib/ai/provider";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveProviderForTest).mockReset();
});

interface ApiErrorEnvelope {
  data: null;
  error: string;
}

interface ApiSuccessEnvelope<T> {
  data: T;
  error: null;
}

function emptyRequest(): Request {
  return new Request("http://localhost/api/ai/test", {
    method: "POST",
    headers: { "content-length": "0" },
  });
}

function jsonRequest(body: unknown): Request {
  const text = JSON.stringify(body);
  return new Request("http://localhost/api/ai/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(text.length),
    },
    body: text,
  });
}

interface TestFailureEnvelope {
  data: {
    ok: false;
    providerType: string;
    reasonCode: "credentials" | "rate_limited" | "server_error" | "unreachable";
    reason: string;
  };
  error: null;
}

// V3 audit: /api/ai/test was returning provider err.message + bodyExcerpt
// directly to the client, leaking provider URLs / partial keys / internal
// headers. Server now logs full details via annotate() and responds with
// a categorised, secret-free reason.
//
// This route MUST NEVER return a 5xx: a 5xx origin response is rewritten
// by Cloudflare to its own HTML error page, so the browser's res.json()
// crashes with `Unexpected token '<', "<!DOCTYPE "`. Every provider-call
// failure returns HTTP 200 with `{ ok:false, reason }` the client shows
// verbatim.
describe("POST /api/ai/test — provider error leak guard + non-5xx contract", () => {
  function makeProviderThatThrows(
    err: Error & { httpStatus?: number; bodyExcerpt?: string },
  ) {
    vi.mocked(resolveProviderForTest).mockResolvedValue({
      type: "openai",
      generateCompletion: vi.fn(async () => {
        throw err;
      }),
    } as never);
  }

  it("never returns a 5xx and does not echo provider err.message back to the client", async () => {
    const err = Object.assign(
      new Error("OpenAI 401 from https://api.openai.com/v1 sk-leaked-key"),
      {
        httpStatus: 401 as const,
        bodyExcerpt: '{"error":"invalid api key sk-secret"}',
      },
    );
    makeProviderThatThrows(err);

    const response = await POST(emptyRequest() as never);
    // Always JSON-parseable, never a 5xx (the Cloudflare HTML-rewrite
    // root cause of "Unexpected token '<'…").
    expect(response.status).toBe(200);
    const body = (await response.json()) as TestFailureEnvelope;
    expect(body.data.ok).toBe(false);
    expect(body.data.reasonCode).toBe("credentials");
    // The stable machine code must itself be secret-free.
    expect(body.data.reasonCode).not.toMatch(/sk-/);
    expect(body.data.reason).not.toMatch(/sk-/);
    expect(body.data.reason).not.toMatch(/api\.openai\.com/);
    expect(body.data.reason).not.toMatch(/invalid api key/i);
    expect(body.data.reason).toMatch(/re-authenticate/i);
  });

  it("reclassifies a 5xx whose body signals an invalidated session as a credential failure", async () => {
    // The shape an operator hit: re-auth, gateway answers 500 with
    // "authentication token has been invalidated" instead of a 401.
    makeProviderThatThrows(
      Object.assign(new Error("upstream 500"), {
        httpStatus: 500 as const,
        bodyExcerpt:
          '{"error":{"message":"Your authentication token has been invalidated. Please try signing in again."}}',
      }),
    );
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as TestFailureEnvelope;
    expect(body.data.ok).toBe(false);
    expect(body.data.reasonCode).toBe("credentials");
    expect(body.data.reason).toMatch(/re-authenticate/i);
  });

  it("categorises a 429 rate-limit", async () => {
    makeProviderThatThrows(
      Object.assign(new Error("429 from openai"), { httpStatus: 429 as const }),
    );
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as TestFailureEnvelope;
    expect(body.data.reasonCode).toBe("rate_limited");
    expect(body.data.reason).toMatch(/rate-limited/i);
  });

  it("categorises a plain 5xx provider server error (no auth signal)", async () => {
    makeProviderThatThrows(
      Object.assign(new Error("503 upstream"), { httpStatus: 503 as const }),
    );
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as TestFailureEnvelope;
    expect(body.data.reasonCode).toBe("server_error");
    expect(body.data.reason).toMatch(/server error/i);
  });

  it("categorises a network/timeout failure", async () => {
    makeProviderThatThrows(new Error("ECONNRESET"));
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as TestFailureEnvelope;
    expect(body.data.reasonCode).toBe("unreachable");
    expect(body.data.reason).toMatch(/could not reach/i);
  });
});

// v1.4 fix: the dropdown in /settings was not honoured — the test always
// ran against the SAVED provider (the maintainer reported "wirft was Komisches raus").
// The route now accepts a JSON override body and forwards the user's
// unsaved selection to resolveProviderForTest().
describe("POST /api/ai/test — dropdown-aware override", () => {
  function makeProviderThatSucceeds(model: string) {
    vi.mocked(resolveProviderForTest).mockResolvedValue({
      type: "anthropic",
      generateCompletion: vi.fn(async () => ({
        content: '{"ok":true}',
        providerType: "anthropic",
        model,
        tokensUsed: 5,
      })),
    } as never);
  }

  it("forwards a dropdown override to resolveProviderForTest", async () => {
    makeProviderThatSucceeds("claude-3-5-sonnet-latest");
    const response = await POST(
      jsonRequest({
        provider: "ANTHROPIC",
        model: "claude-3-5-sonnet-latest",
      }) as never,
    );
    expect(response.status).toBe(200);
    expect(resolveProviderForTest).toHaveBeenCalledWith("u-1", {
      provider: "ANTHROPIC",
      model: "claude-3-5-sonnet-latest",
    });
    const body = (await response.json()) as ApiSuccessEnvelope<{
      providerType: string;
      model: string;
    }>;
    expect(body.data.providerType).toBe("anthropic");
    expect(body.data.model).toBe("claude-3-5-sonnet-latest");
  });

  it("rejects unknown provider values with 422", async () => {
    const response = await POST(
      jsonRequest({ provider: "MALICIOUS" }) as never,
    );
    expect(response.status).toBe(422);
    expect(resolveProviderForTest).not.toHaveBeenCalled();
  });

  it("uses the persisted config when the body is empty", async () => {
    makeProviderThatSucceeds("claude-3-5-sonnet-latest");
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(200);
    expect(resolveProviderForTest).toHaveBeenCalledWith("u-1", {});
  });

  it("surfaces config errors as the same status as the resolver throws", async () => {
    const { AITestConfigError } = await import("@/lib/ai/provider");
    vi.mocked(resolveProviderForTest).mockRejectedValueOnce(
      new AITestConfigError(422, "Anthropic API key not configured"),
    );
    const response = await POST(
      jsonRequest({ provider: "ANTHROPIC" }) as never,
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error).toBe("Anthropic API key not configured");
  });
});
