import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn() },
    cycleProfile: { findUnique: vi.fn().mockResolvedValue(null) },
  },
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

// Stub the heavy generator so the route test stays isolated.
vi.mock("@/lib/insights/mood-status", () => ({
  generateMoodStatusForUser: vi.fn(async () => ({
    hasProvider: true,
    text: "ok",
    cached: true,
    updatedAt: new Date().toISOString(),
  })),
  resolveMoodStatusLocale: () => "en",
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { generateMoodStatusForUser } from "@/lib/insights/mood-status";

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
function makeReq(): NextRequest {
  return new NextRequest(new URL("http://localhost/api/insights/mood-status"));
}

/** Persisted module-preferences blob for the gated user row. */
function userRow(modulePreferencesJson: unknown) {
  return {
    gender: null,
    disableCoach: false,
    modulePreferencesJson,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(null as never);
});

describe("GET /api/insights/mood-status — module gate", () => {
  it("200s when the mood module is enabled (default-on, no blob)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(userRow(null) as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { text: string } | null };
    expect(body.data?.text).toBe("ok");
    expect(generateMoodStatusForUser).toHaveBeenCalled();
  });

  it("403s + module.disabled when mood is turned off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      userRow({ mood: false }) as never,
    );
    const res = await callGet(makeReq());
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      meta?: { errorCode?: string; module?: string };
    };
    expect(body.meta?.errorCode).toBe("module.disabled");
    expect(body.meta?.module).toBe("mood");
    expect(generateMoodStatusForUser).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
  });
});
