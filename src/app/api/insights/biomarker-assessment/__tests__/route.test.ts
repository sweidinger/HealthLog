import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

// The route resolves the `insights` module gate after `requireAuth()`. Mock
// it default-enabled so the assertions ride through; the off → 403 coverage
// lives in the route-gate inventory test.
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// Stub the heavy generator so the route test stays isolated from the real
// status pipeline.
vi.mock("@/lib/insights/biomarker-status", () => ({
  generateBiomarkerStatus: vi.fn(async () => ({
    hasProvider: true,
    text: "ok",
    cached: true,
    updatedAt: new Date().toISOString(),
  })),
}));

vi.mock("@/lib/insights/metric-status", () => ({
  resolveMetricStatusLocale: () => "en",
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { generateBiomarkerStatus } from "@/lib/insights/biomarker-status";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(biomarkerId?: string): NextRequest {
  const url = new URL("http://localhost/api/insights/biomarker-assessment");
  if (biomarkerId !== undefined)
    url.searchParams.set("biomarkerId", biomarkerId);
  return new NextRequest(url);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
});

describe("GET /api/insights/biomarker-assessment", () => {
  it("returns 200 + envelope and calls the generator read-only", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq("bm-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { text: string; hasProvider: boolean } | null;
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(body.data?.text).toBe("ok");
    expect(generateBiomarkerStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        biomarkerId: "bm-1",
        userId: "user-1",
        readOnly: true,
      }),
    );
  });

  it("422s on a missing biomarkerId without calling the generator", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(422);
    expect(generateBiomarkerStatus).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq("bm-1"));
    expect(res.status).toBe(401);
  });

  it("403s + errorCode when insightStatus is disabled", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: false,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    } as never);
    const res = await callGet(makeReq("bm-1"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("assistant.disabled.insightStatus");
  });
});
