import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((value: string) => `enc(${value})`),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateAppSettings: vi.fn(),
}));

vi.mock("web-push", () => ({
  generateVAPIDKeys: vi.fn(() => ({
    publicKey: "GENERATED_PUBLIC",
    privateKey: "GENERATED_PRIVATE",
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin, HttpError } from "@/lib/api-handler";
import { encrypt } from "@/lib/crypto";
import { auditLog } from "@/lib/auth/audit";

const ADMIN_CTX = {
  authMethod: "cookie" as const,
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "admin-1", username: "admin", role: "ADMIN" } as never,
};

function jsonReq(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/admin/settings/web-push-vapid/generate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
  vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
    id: "singleton",
  } as never);
});

describe("POST /api/admin/settings/web-push-vapid/generate", () => {
  it("rejects with 401 when no session (admin-gated)", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(401, "Not authenticated"),
    );
    await expect(POST(jsonReq({}))).rejects.toThrow("Not authenticated");
  });

  it("rejects with 403 for a non-admin (cookie-only boundary)", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(403, "Admin access required"),
    );
    await expect(POST(jsonReq({}))).rejects.toThrow("Admin access required");
  });

  it("generates a keypair and stores the private key encrypted", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);

    const res = await POST(jsonReq({}));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        webPushVapidPublicKey: string;
        webPushVapidSubject: string;
        webPushVapidConfigured: boolean;
      };
    };
    expect(body.data.webPushVapidPublicKey).toBe("GENERATED_PUBLIC");
    expect(body.data.webPushVapidConfigured).toBe(true);
    // Default placeholder subject seeded so the keypair is immediately valid.
    expect(body.data.webPushVapidSubject).toBe("mailto:admin@example.com");

    // Private key encrypted before persistence; never returned in the body.
    expect(encrypt).toHaveBeenCalledWith("GENERATED_PRIVATE");
    expect(JSON.stringify(body.data)).not.toContain("GENERATED_PRIVATE");

    const upsert = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0];
    expect(upsert?.where).toEqual({ id: "singleton" });
    expect(upsert?.update).toMatchObject({
      webPushVapidPublicKey: "GENERATED_PUBLIC",
      webPushVapidPrivateKeyEncrypted: "enc(GENERATED_PRIVATE)",
    });
  });

  it("never logs the plaintext private key in the audit detail", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    await POST(jsonReq({}));
    expect(auditLog).toHaveBeenCalled();
    const details = vi.mocked(auditLog).mock.calls[0]?.[1]?.details as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(details)).not.toContain("GENERATED_PRIVATE");
    expect(details.webPushVapidPrivateKeyUpdated).toBe(true);
    expect(details.replacedExisting).toBe(false);
  });

  it("refuses with 409 when keys already exist and force is absent", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      webPushVapidPublicKey: "OLD_PUBLIC",
      webPushVapidPrivateKeyEncrypted: "OLD_ENC",
      webPushVapidSubject: "mailto:old@example.com",
    } as never);

    const res = await POST(jsonReq({}));
    expect(res.status).toBe(409);
    expect(prisma.appSettings.upsert).not.toHaveBeenCalled();
  });

  it("overwrites existing keys when force is true and keeps the subject", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      webPushVapidPublicKey: "OLD_PUBLIC",
      webPushVapidPrivateKeyEncrypted: "OLD_ENC",
      webPushVapidSubject: "mailto:keep@example.com",
    } as never);

    const res = await POST(jsonReq({ force: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { webPushVapidSubject: string };
    };
    // Existing subject preserved when no override is supplied.
    expect(body.data.webPushVapidSubject).toBe("mailto:keep@example.com");

    const details = vi.mocked(auditLog).mock.calls[0]?.[1]?.details as Record<
      string,
      unknown
    >;
    expect(details.replacedExisting).toBe(true);
  });

  it("rejects an invalid subject override with 422", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    const res = await POST(jsonReq({ subject: "not-a-mailto" }));
    expect(res.status).toBe(422);
    expect(prisma.appSettings.upsert).not.toHaveBeenCalled();
  });

  it("returns 415 when content-type is not JSON", async () => {
    const r = new NextRequest(
      "http://localhost/api/admin/settings/web-push-vapid/generate",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      },
    );
    const res = await POST(r);
    expect(res.status).toBe(415);
  });
});
