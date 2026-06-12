/**
 * v1.16.11 — reminder-thresholds GET: the operator-level late / missed
 * minutes ride along unchanged; the new `lowStockRunwayDays` field is
 * PER-USER (from `notificationPrefs.medication`), so the endpoint
 * reflects whatever the notification-prefs PATCH persisted — the read
 * half of the settings round-trip.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    appSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function mkGet(): Request {
  return new Request("http://localhost/api/settings/reminder-thresholds");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    reminderLateMinutes: 120,
    reminderMissedMinutes: 240,
  } as never);
});

describe("GET /api/settings/reminder-thresholds", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (GET as (r: Request) => Promise<Response>)(mkGet());
    expect(res.status).toBe(401);
  });

  it("returns the default low-stock threshold (7) for a fresh user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: null,
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(mkGet());
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: {
        lateMinutes: number;
        missedMinutes: number;
        lowStockRunwayDays: number | null;
      };
    };
    expect(env.data).toEqual({
      lateMinutes: 120,
      missedMinutes: 240,
      lowStockRunwayDays: 7,
    });
  });

  it("reflects the per-user threshold persisted by the prefs PATCH", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { lowStockRunwayDays: 21 } },
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(mkGet());
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { lowStockRunwayDays: number | null };
    };
    expect(env.data.lowStockRunwayDays).toBe(21);
  });

  it("reflects the OFF state as null", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { lowStockRunwayDays: null } },
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(mkGet());
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { lowStockRunwayDays: number | null };
    };
    expect(env.data.lowStockRunwayDays).toBe(null);
  });
});
