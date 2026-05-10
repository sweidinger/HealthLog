/**
 * Integration regression guard for `src/lib/auth/session.ts`.
 *
 * The session helpers couple Postgres (`Session` row), the `cookies()`
 * adapter from `next/headers`, and the `db-compat` schema-migration
 * fallback. A unit test with a mocked Prisma client cannot verify the
 * end-to-end flow — particularly the expired-session purge behaviour,
 * which silently deletes the row before returning null.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

// Stateful in-memory cookie jar so `createSession()` (which calls
// cookies().set) hands the value off to a subsequent `getSession()`
// (which calls cookies().get), exactly as the request lifecycle does.
// The Map lives in `mock-next-headers.ts` so all integration files
// share the same backing store under vitest `isolate: false`.
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

// `db-compat` runs ALTER TABLE IF NOT EXISTS statements that are no-ops
// against a freshly-migrated schema but slow tests down — short-circuit.
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
});

describe("session lifecycle (real Postgres)", () => {
  it("createSession writes a row and getSession reads it back", async () => {
    const { createSession, getSession } = await import("@/lib/auth/session");

    const user = await getPrismaClient().user.create({
      data: { username: "session-test", email: "session@example.test" },
    });

    const sessionId = await createSession(
      user.id,
      true,
      "127.0.0.1",
      "vitest/1.0",
    );

    const row = await getPrismaClient().session.findUnique({
      where: { id: sessionId },
    });
    expect(row).not.toBeNull();
    expect(row?.userId).toBe(user.id);
    expect(row?.ipAddress).toBe("127.0.0.1");
    expect(row?.userAgent).toBe("vitest/1.0");

    const result = await getSession();
    expect(result).not.toBeNull();
    expect(result?.user.id).toBe(user.id);
    expect(result?.session.id).toBe(sessionId);
  });

  it("rejects expired sessions and purges the stale row", async () => {
    const { createSession, getSession } = await import("@/lib/auth/session");

    const user = await getPrismaClient().user.create({
      data: { username: "expired-session", email: "expired@example.test" },
    });

    const sessionId = await createSession(user.id, false);

    // Force the row past its expiry — getSession must purge it.
    await getPrismaClient().session.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await getSession();
    expect(result).toBeNull();

    const purged = await getPrismaClient().session.findUnique({
      where: { id: sessionId },
    });
    expect(purged).toBeNull();
  });

  it("returns null when no session cookie is present", async () => {
    const { getSession } = await import("@/lib/auth/session");
    expect(await getSession()).toBeNull();
  });

  /**
   * v1.4.22 W5 reconcile (Sr-H1) — `createSession` now anchors the
   * `hl_onboarding` cookie itself so issuing a session without it is
   * type-impossible. Pin the contract so a future auth surface added
   * without the helper can never reintroduce the dashboard flash.
   */
  it("createSession sets the hl_onboarding cookie when onboardingPending=true", async () => {
    const { createSession } = await import("@/lib/auth/session");
    const user = await getPrismaClient().user.create({
      data: { username: "onb-pending", email: "pending@example.test" },
    });
    await createSession(user.id, true);
    expect(cookieJar.get("hl_onboarding")).toBe("pending");
  });

  it("createSession clears the hl_onboarding cookie when onboardingPending=false", async () => {
    const { createSession } = await import("@/lib/auth/session");
    const user = await getPrismaClient().user.create({
      data: { username: "onb-done", email: "done@example.test" },
    });
    cookieJar.set("hl_onboarding", "pending"); // simulate stale value
    await createSession(user.id, false);
    expect(cookieJar.get("hl_onboarding")).toBeUndefined();
  });

  it("destroySession clears the hl_onboarding cookie alongside the session cookie", async () => {
    const { createSession, destroySession } = await import(
      "@/lib/auth/session"
    );
    const user = await getPrismaClient().user.create({
      data: { username: "dest", email: "dest@example.test" },
    });
    await createSession(user.id, true);
    expect(cookieJar.get("hl_onboarding")).toBe("pending");
    await destroySession();
    expect(cookieJar.get("hl_onboarding")).toBeUndefined();
    expect(cookieJar.get("healthlog_session")).toBeUndefined();
  });
});
