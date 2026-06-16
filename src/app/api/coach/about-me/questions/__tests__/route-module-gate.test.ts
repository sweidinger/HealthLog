import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.18.0 — the clarifying-questions GET/DELETE enforce the two-layer
 * Coach module gate (operator availability AND the per-user
 * `disableCoach` opt-out) right after auth. A disabled module returns
 * the 403 `module.disabled` envelope before any pending-question read or
 * mutation; an enabled module proceeds to the normal 200 path.
 */

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

const { requireModuleEnabled } = vi.hoisted(() => ({
  requireModuleEnabled: vi.fn(),
}));
vi.mock("@/lib/modules/gate", () => ({ requireModuleEnabled }));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  returnAllZodIssues: (_e: unknown, status: number) => ({
    data: null,
    error: "validation",
    status,
  }),
  safeJson: async () => ({ data: {}, error: null }),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getPendingQuestionsForUser: vi.fn(async () => ["q1"]),
  setPendingQuestionsForUser: vi.fn(),
  PENDING_QUESTION_MAX_CHARS: 200,
}));

import { GET, DELETE } from "../route";

type Envelope = {
  data: unknown;
  error: string | null;
  status: number;
  meta?: { errorCode?: string; module?: string };
};
const get = GET as unknown as () => Promise<Envelope>;
const del = DELETE as unknown as (req: Request) => Promise<Envelope>;

const disabledResponse: Envelope = {
  data: null,
  error: 'Module "coach" is not enabled',
  status: 403,
  meta: { errorCode: "module.disabled", module: "coach" },
};

function delReq(): Request {
  return new Request("http://localhost/api/coach/about-me/questions", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("about-me questions module gate", () => {
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

  it("DELETE returns 403 module.disabled when Coach is disabled", async () => {
    requireModuleEnabled.mockResolvedValue({
      enabled: false,
      response: disabledResponse,
    });
    const res = await del(delReq());
    expect(res.status).toBe(403);
    expect(res.meta?.module).toBe("coach");
  });

  it("DELETE returns 200 when Coach is enabled", async () => {
    requireModuleEnabled.mockResolvedValue({ enabled: true });
    const res = await del(delReq());
    expect(res.status).toBe(200);
  });
});
