import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.18.0 — the about-me self-context GET/PUT enforce the two-layer
 * Coach module gate (operator availability AND the per-user
 * `disableCoach` opt-out) right after auth. A disabled module returns
 * the 403 `module.disabled` envelope before any self-context read or
 * write; an enabled module proceeds to the normal 200 path.
 */

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
}));

const { requireModuleEnabled } = vi.hoisted(() => ({
  requireModuleEnabled: vi.fn(),
}));
vi.mock("@/lib/modules/gate", () => ({ requireModuleEnabled }));

vi.mock("@/lib/api-response", () => ({
  apiError: (error: string, status: number, meta?: unknown) => ({
    data: null,
    error,
    status,
    meta,
  }),
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  getClientIp: () => "127.0.0.1",
  returnAllZodIssues: (_e: unknown, status: number) => ({
    data: null,
    error: "validation",
    status,
  }),
  safeJson: async (req: Request) => ({ data: await req.json(), error: null }),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    userHealthProfile: {
      findUnique: vi.fn(async () => ({ updatedAt: new Date(0) })),
      upsert: vi.fn(async () => ({ updatedAt: new Date(0) })),
    },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (s: string) => Buffer.from(s),
}));
const emptyCtx = {
  aboutMe: null,
  conditions: null,
  allergies: null,
  coachFocus: null,
};
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextForUser: vi.fn(async () => emptyCtx),
  getPendingQuestionsForUser: vi.fn(async () => []),
  setPendingQuestionsForUser: vi.fn(),
}));
vi.mock("@/lib/ai/coach/self-context-questions", () => ({
  deriveClarifyingQuestions: vi.fn(async () => ({
    questions: [],
    source: "none",
  })),
}));

import { GET, PUT } from "../route";

type Envelope = {
  data: unknown;
  error: string | null;
  status: number;
  meta?: { errorCode?: string; module?: string };
};
const get = GET as unknown as () => Promise<Envelope>;
const put = PUT as unknown as (req: Request) => Promise<Envelope>;

const disabledResponse: Envelope = {
  data: null,
  error: 'Module "coach" is not enabled',
  status: 403,
  meta: { errorCode: "module.disabled", module: "coach" },
};

function putReq(): Request {
  return new Request("http://localhost/api/coach/about-me", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aboutMe: "I run daily" }),
  });
}

describe("about-me module gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET returns 403 module.disabled when Coach is disabled", async () => {
    requireModuleEnabled.mockResolvedValue({
      enabled: false,
      response: disabledResponse,
    });
    const res = await get();
    expect(res.status).toBe(403);
    expect(res.meta?.errorCode).toBe("module.disabled");
    expect(requireModuleEnabled).toHaveBeenCalledWith("u1", "coach");
  });

  it("GET returns 200 when Coach is enabled", async () => {
    requireModuleEnabled.mockResolvedValue({ enabled: true });
    const res = await get();
    expect(res.status).toBe(200);
  });

  it("PUT returns 403 module.disabled when Coach is disabled", async () => {
    requireModuleEnabled.mockResolvedValue({
      enabled: false,
      response: disabledResponse,
    });
    const res = await put(putReq());
    expect(res.status).toBe(403);
    expect(res.meta?.module).toBe("coach");
  });

  it("PUT returns 200 when Coach is enabled", async () => {
    requireModuleEnabled.mockResolvedValue({ enabled: true });
    const res = await put(putReq());
    expect(res.status).toBe(200);
  });
});
