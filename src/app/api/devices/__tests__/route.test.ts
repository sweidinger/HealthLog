import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    device: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.device.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.device.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.device.create).mockResolvedValue({ id: "dev-1" } as never);
  vi.mocked(prisma.device.update).mockResolvedValue({ id: "dev-1" } as never);
});

describe("POST /api/devices", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 422 for missing token", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(req({ bundleId: "io.healthlog.app" }));
    expect(res.status).toBe(422);
  });

  it("creates a new device row when token is unknown", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        locale: "de-DE",
        appVersion: "1.0.0",
        model: "iPhone15,2",
      }),
    );
    expect(res.status).toBe(201);
    expect(prisma.device.create).toHaveBeenCalledTimes(1);
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it("rejects cross-user re-registration with 409", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-1",
      userId: "other-user",
      token: "abcd1234efgh5678",
    } as never);
    const res = await POST(
      req({ token: "abcd1234efgh5678", bundleId: "io.healthlog.app" }),
    );
    expect(res.status).toBe(409);
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(prisma.device.create).not.toHaveBeenCalled();
  });

  it("updates in place when same user re-registers their own token", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-1",
      userId: "user-1",
      token: "abcd1234efgh5678",
    } as never);
    const res = await POST(
      req({ token: "abcd1234efgh5678", bundleId: "io.healthlog.app" }),
    );
    expect(res.status).toBe(201);
    expect(prisma.device.update).toHaveBeenCalledTimes(1);
    expect(prisma.device.create).not.toHaveBeenCalled();
  });

  it("returns 422 when only apnsToken is supplied without apnsEnvironment", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        apnsToken: "deadbeef".repeat(8),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when only apnsEnvironment is supplied without apnsToken", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        apnsEnvironment: "sandbox",
      }),
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when apnsToken is not hex", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        apnsToken: "not-hex-z",
        apnsEnvironment: "sandbox",
      }),
    );
    expect(res.status).toBe(422);
  });

  it("creates a Device row with the apnsToken + apnsEnvironment pair", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        apnsToken: "deadbeef".repeat(8),
        apnsEnvironment: "sandbox",
      }),
    );
    expect(res.status).toBe(201);
    expect(prisma.device.create).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.device.create).mock.calls[0][0] as {
      data: { apnsToken?: string; apnsEnvironment?: string };
    };
    expect(args.data.apnsToken).toBe("deadbeef".repeat(8));
    expect(args.data.apnsEnvironment).toBe("sandbox");
  });

  it("rejects re-registration of an apnsToken owned by another user with 409", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.device.findFirst).mockResolvedValue({
      id: "other-dev",
    } as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        apnsToken: "deadbeef".repeat(8),
        apnsEnvironment: "sandbox",
      }),
    );
    expect(res.status).toBe(409);
    expect(prisma.device.create).not.toHaveBeenCalled();
    expect(prisma.device.update).not.toHaveBeenCalled();
  });
});
