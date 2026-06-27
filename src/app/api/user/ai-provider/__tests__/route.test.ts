import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be hoisted before importing the route.
vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => `dec:${v}`),
  encrypt: vi.fn((v: string) => `enc:${v}`),
}));

vi.mock("@/lib/ai/provider", () => ({
  resolveProviderAvailability: vi.fn(),
}));

vi.mock("@/lib/validations/notifications", () => ({
  isPublicUrl: vi.fn(() => true),
}));

vi.mock("@/lib/ai/local-host-allowlist", () => ({
  isLocalAiHostAllowed: vi.fn(() => false),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { GET, PATCH } from "../route";
import { prisma } from "@/lib/db";
import { resolveProviderAvailability } from "@/lib/ai/provider";

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/user/ai-provider", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface AiProviderResponse {
  data: {
    provider: string | null;
    aiAvailable: boolean;
    managedBy: "user" | "local" | "server" | null;
    hasAnthropicKey: boolean;
    hasOpenaiKey: boolean;
  };
  error: null;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/user/ai-provider availability", () => {
  it("reports available + managedBy:user when the user holds a BYO key", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: "OPENAI",
      aiModel: "gpt-4o",
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: "enc-openai",
    } as never);
    vi.mocked(resolveProviderAvailability).mockResolvedValue({
      aiAvailable: true,
      managedBy: "user",
    });

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as AiProviderResponse;

    expect(vi.mocked(resolveProviderAvailability)).toHaveBeenCalledWith("u-1");
    expect(body.data.aiAvailable).toBe(true);
    expect(body.data.managedBy).toBe("user");
    expect(body.data.hasOpenaiKey).toBe(true);
  });

  it("reports available + managedBy:server when only an admin-managed provider exists", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: null,
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
    } as never);
    vi.mocked(resolveProviderAvailability).mockResolvedValue({
      aiAvailable: true,
      managedBy: "server",
    });

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as AiProviderResponse;

    // The user has no personal key, but the Coach must still surface.
    expect(body.data.provider).toBeNull();
    expect(body.data.hasOpenaiKey).toBe(false);
    expect(body.data.aiAvailable).toBe(true);
    expect(body.data.managedBy).toBe("server");
  });

  it("reports aiAvailable:false + managedBy:null when nothing is configured", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: null,
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
    } as never);
    vi.mocked(resolveProviderAvailability).mockResolvedValue({
      aiAvailable: false,
      managedBy: null,
    });

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as AiProviderResponse;

    expect(body.data.aiAvailable).toBe(false);
    expect(body.data.managedBy).toBeNull();
  });

  it("returns the v1.22 timeout + OCR fields", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: "OPENAI",
      aiModel: "gpt-4o",
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
      aiResponseTimeoutSeconds: 240,
      aiOcrEnabled: true,
      aiOcrProvider: "ANTHROPIC",
      aiOcrModel: "claude-sonnet-4-6",
      aiOcrBaseUrl: null,
      aiOcrKeyEncrypted: "enc-ocr-1234",
    } as never);
    vi.mocked(resolveProviderAvailability).mockResolvedValue({
      aiAvailable: true,
      managedBy: "user",
    });

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as {
      data: {
        responseTimeoutSeconds: number | null;
        ocrEnabled: boolean;
        ocrProvider: string | null;
        hasOcrKey: boolean;
        ocrKeyPreview: string | null;
      };
    };

    expect(body.data.responseTimeoutSeconds).toBe(240);
    expect(body.data.ocrEnabled).toBe(true);
    expect(body.data.ocrProvider).toBe("ANTHROPIC");
    expect(body.data.hasOcrKey).toBe(true);
    // Preview is `...` + last 4 of the decrypted value (decrypt → `dec:...`).
    expect(body.data.ocrKeyPreview).toMatch(/^\.\.\./);
  });
});

describe("PATCH /api/user/ai-provider — v1.22 fields", () => {
  const patch = PATCH as (req: Request) => Promise<Response>;

  it("persists a valid response timeout", async () => {
    const res = await patch(patchRequest({ responseTimeoutSeconds: 120 }));
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiResponseTimeoutSeconds: 120 }),
      }),
    );
  });

  it("rejects an out-of-range response timeout", async () => {
    await expect(
      patch(patchRequest({ responseTimeoutSeconds: 5 })),
    ).rejects.toThrow(/between 10 and 600/);
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("clears the timeout when null is sent", async () => {
    await patch(patchRequest({ responseTimeoutSeconds: null }));
    expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiResponseTimeoutSeconds: null }),
      }),
    );
  });

  it("persists OCR provider config and encrypts the key", async () => {
    const res = await patch(
      patchRequest({
        ocrEnabled: true,
        ocrProvider: "OPENAI",
        ocrModel: "gpt-4o",
        ocrKey: "sk-ocr-secret",
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aiOcrEnabled: true,
          aiOcrProvider: "OPENAI",
          aiOcrModel: "gpt-4o",
          aiOcrKeyEncrypted: "enc:sk-ocr-secret",
        }),
      }),
    );
  });

  it("rejects an invalid OCR provider", async () => {
    await expect(
      patch(patchRequest({ ocrProvider: "CHATGPT_OAUTH" })),
    ).rejects.toThrow(/Invalid OCR provider/);
  });
});
