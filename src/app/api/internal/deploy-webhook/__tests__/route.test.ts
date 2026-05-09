import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// --- Module-boundary mocks must come before importing the route. ---

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => ({
    setAuth: vi.fn(),
    addWarning: vi.fn(),
  })),
}));

import { POST, GET } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { checkRateLimit } from "@/lib/rate-limit";
import { getEvent } from "@/lib/logging/context";

const ORIGINAL_SECRET = process.env.DEPLOY_WEBHOOK_SECRET;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.DEPLOY_WEBHOOK_SECRET = "test-secret";
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(getEvent).mockReturnValue({
    setAuth: vi.fn(),
    addWarning: vi.fn(),
  } as never);
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.DEPLOY_WEBHOOK_SECRET;
  else process.env.DEPLOY_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

function jsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/internal/deploy-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/deploy-webhook", () => {
  it("returns 401 with no secret header", async () => {
    const res = await POST(jsonRequest({ status: "success" }));
    expect(res.status).toBe(401);
    expect(auditLog).not.toHaveBeenCalled();
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("returns 401 with a wrong secret", async () => {
    const res = await POST(
      jsonRequest(
        { status: "success" },
        { "x-deploy-webhook-secret": "WRONG" },
      ),
    );
    expect(res.status).toBe(401);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("returns 401 when DEPLOY_WEBHOOK_SECRET env var is unset, regardless of header", async () => {
    delete process.env.DEPLOY_WEBHOOK_SECRET;
    const addWarning = vi.fn();
    vi.mocked(getEvent).mockReturnValue({
      setAuth: vi.fn(),
      addWarning,
    } as never);

    const res = await POST(
      jsonRequest(
        { status: "success" },
        { "x-deploy-webhook-secret": "anything" },
      ),
    );
    expect(res.status).toBe(401);
    expect(addWarning).toHaveBeenCalledWith(
      "DEPLOY_WEBHOOK_SECRET not configured",
    );
  });

  it("happy path: success payload writes system.deploy.success audit row, no admin alert", async () => {
    const res = await POST(
      jsonRequest(
        {
          status: "success",
          application_name: "HealthLog",
          application_uuid: "pg8wggwogo8c4gc4ks0kk4ss",
          deployment_uuid: "dep-123",
        },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; outcome: string };
    expect(body).toEqual({ status: "ok", outcome: "success" });

    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      "system.deploy.success",
      expect.objectContaining({
        details: expect.objectContaining({
          applicationName: "HealthLog",
          applicationUuid: "pg8wggwogo8c4gc4ks0kk4ss",
          deploymentUuid: "dep-123",
          error: null,
          raw: expect.objectContaining({ status: "success" }),
        }),
      }),
    );
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("failure payload writes system.deploy.failure audit row AND fans a SYSTEM_ALERT to every admin", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: "admin-1" },
      { id: "admin-2" },
    ] as never);

    const res = await POST(
      jsonRequest(
        {
          status: "failed",
          application_name: "HealthLog",
          application_uuid: "pg8wggwogo8c4gc4ks0kk4ss",
          deployment_uuid: "dep-456",
          error: "container exited 137",
        },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe("failure");

    expect(auditLog).toHaveBeenCalledWith(
      "system.deploy.failure",
      expect.objectContaining({
        details: expect.objectContaining({
          error: "container exited 137",
        }),
      }),
    );

    expect(dispatchNotification).toHaveBeenCalledTimes(2);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "SYSTEM_ALERT",
        userId: "admin-1",
        title: expect.stringContaining("Deploy failed"),
        message: expect.stringContaining("container exited 137"),
        metadata: expect.objectContaining({
          source: "deploy-webhook",
          deploymentUuid: "dep-456",
        }),
      }),
    );
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "admin-2" }),
    );
  });

  it("treats unknown statuses (e.g. 'queued') as system.deploy.unknown without alerting", async () => {
    const res = await POST(
      jsonRequest(
        { status: "queued", application_name: "HealthLog" },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe("unknown");
    expect(auditLog).toHaveBeenCalledWith(
      "system.deploy.unknown",
      expect.any(Object),
    );
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("emits a Wide Event warning when a deploy fails but no admin user exists", async () => {
    const addWarning = vi.fn();
    vi.mocked(getEvent).mockReturnValue({
      setAuth: vi.fn(),
      addWarning,
    } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([] as never);

    await POST(
      jsonRequest(
        { status: "failed", application_name: "HealthLog" },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );

    expect(addWarning).toHaveBeenCalledWith(
      expect.stringMatching(/no admin user/i),
    );
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("returns 429 and skips audit + alert when rate-limited", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);

    const res = await POST(
      jsonRequest(
        { status: "success" },
        { "x-deploy-webhook-secret": "test-secret" },
      ),
    );
    expect(res.status).toBe(429);
    expect(auditLog).not.toHaveBeenCalled();
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("tolerates malformed (non-string) status fields by treating them as unknown", async () => {
    const res = await POST(
      jsonRequest({ status: 42 }, { "x-deploy-webhook-secret": "test-secret" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe("unknown");
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("preserves the full Coolify payload in the audit-log raw field for forward compat", async () => {
    const fullPayload = {
      status: "success",
      application_name: "HealthLog",
      application_uuid: "pg8wggwogo8c4gc4ks0kk4ss",
      deployment_uuid: "dep-789",
      future_field: { commit_sha: "abc123", environment: "production" },
    };

    await POST(
      jsonRequest(fullPayload, { "x-deploy-webhook-secret": "test-secret" }),
    );

    expect(auditLog).toHaveBeenCalledWith(
      "system.deploy.success",
      expect.objectContaining({
        details: expect.objectContaining({
          raw: expect.objectContaining({
            future_field: { commit_sha: "abc123", environment: "production" },
          }),
        }),
      }),
    );
  });
});

describe("GET /api/internal/deploy-webhook (reachability check)", () => {
  it("returns 200 with valid secret header", async () => {
    const req = new NextRequest(
      "http://localhost/api/internal/deploy-webhook",
      {
        method: "GET",
        headers: { "x-deploy-webhook-secret": "test-secret" },
      },
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it("returns 401 without a secret", async () => {
    const req = new NextRequest(
      "http://localhost/api/internal/deploy-webhook",
      {
        method: "GET",
      },
    );
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});
