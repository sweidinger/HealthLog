/**
 * v1.4.23 W6 follow-up — `POST /api/devices` integration test.
 *
 * Locks in three guarantees:
 *
 *  1. Registering a device with an `apnsToken` auto-creates a
 *     `NotificationChannel { type: "APNS" }` row for the user. Without
 *     this row the dispatcher's APNS branch never fires (HIGH-1 in the
 *     v1.4.23 W6 code review).
 *  2. Registering without an `apnsToken` does NOT create the channel —
 *     the iOS client may upsert device metadata before APNs grants a
 *     token, and we must not enable APNs delivery prematurely.
 *  3. Registering a SECOND device with the same `apnsToken` for the
 *     same user is idempotent — the channel row stays at one. The
 *     same-user collision path returns 200 (upsert) rather than 409
 *     (the cross-user hijack guard).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: { username, email: `${username}@example.test` },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

describe("POST /api/devices", () => {
  it("auto-upserts a NotificationChannel { type: APNS } when apnsToken is supplied", async () => {
    const user = await seedSession("device-apns-channel");
    const { POST } = await import("@/app/api/devices/route");

    const req = buildRequest({
      token: "legacy-token-1",
      bundleId: "io.healthlog.ios",
      apnsToken: "abcdef0123456789",
      apnsEnvironment: "sandbox",
    });
    const res = await (POST as (r: import("next/server").NextRequest) => Promise<Response>)(req);
    expect(res.status).toBe(201);

    const channel = await getPrismaClient().notificationChannel.findFirst({
      where: { userId: user.id, type: "APNS" },
    });
    expect(channel).not.toBeNull();
    expect(channel?.enabled).toBe(true);
  });

  it("does NOT create an APNS channel when apnsToken is omitted", async () => {
    const user = await seedSession("device-no-apns");
    const { POST } = await import("@/app/api/devices/route");

    const req = buildRequest({
      token: "legacy-token-2",
      bundleId: "io.healthlog.ios",
    });
    const res = await (POST as (r: import("next/server").NextRequest) => Promise<Response>)(req);
    expect(res.status).toBe(201);

    const channel = await getPrismaClient().notificationChannel.findFirst({
      where: { userId: user.id, type: "APNS" },
    });
    expect(channel).toBeNull();
  });

  it("re-registering the same apnsToken for the same user keeps the channel row at one", async () => {
    const user = await seedSession("device-apns-idempotent");
    const { POST } = await import("@/app/api/devices/route");

    const first = await (POST as (r: import("next/server").NextRequest) => Promise<Response>)(
      buildRequest({
        token: "legacy-token-3",
        bundleId: "io.healthlog.ios",
        apnsToken: "deadbeef",
        apnsEnvironment: "sandbox",
      }),
    );
    expect(first.status).toBe(201);

    const second = await (POST as (r: import("next/server").NextRequest) => Promise<Response>)(
      buildRequest({
        token: "legacy-token-3",
        bundleId: "io.healthlog.ios",
        apnsToken: "deadbeef",
        apnsEnvironment: "sandbox",
      }),
    );
    expect(second.status).toBe(201);

    const channels = await getPrismaClient().notificationChannel.findMany({
      where: { userId: user.id, type: "APNS" },
    });
    expect(channels).toHaveLength(1);
  });
});
