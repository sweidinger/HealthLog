/**
 * Integration guard for `validateSessionFromCookieValue` against a real
 * Postgres.
 *
 * The OIDC callback's duplicate-detection path relies on this helper to tell a
 * duplicate of a completed sign-in (a live session → redirect into the app)
 * apart from a forged/expired callback (no session → fail closed). The unit
 * suite stubs the resolver out, so the hashing + row lookup + expiry that
 * actually decide that branch are only exercised here.
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { getPrismaClient, truncateAllTables } from "./setup";
import { hashToken } from "@/lib/auth/hmac";
import { validateSessionFromCookieValue } from "@/lib/auth/session";

const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma);
});

async function makeUser(username: string) {
  return prisma.user.create({
    data: { username, email: `${username}@example.test`, role: "USER" },
  });
}

describe("validateSessionFromCookieValue (integration)", () => {
  it("resolves the user for a live secret-backed session", async () => {
    const user = await makeUser("oidc-dup-live");
    const secret = "hls_" + "a".repeat(64);
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(secret),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const resolved = await validateSessionFromCookieValue(secret);
    expect(resolved?.user.id).toBe(user.id);
  });

  it("returns null for an expired secret-backed session (fail closed)", async () => {
    const user = await makeUser("oidc-dup-expired");
    const secret = "hls_" + "b".repeat(64);
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(secret),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    expect(await validateSessionFromCookieValue(secret)).toBeNull();
  });

  it("returns null for an unknown / forged / empty cookie value", async () => {
    expect(
      await validateSessionFromCookieValue("hls_" + "c".repeat(64)),
    ).toBeNull();
    expect(await validateSessionFromCookieValue(undefined)).toBeNull();
    expect(await validateSessionFromCookieValue("")).toBeNull();
  });

  it("resolves a legacy cuid-cookie session while its tokenHash is null", async () => {
    const user = await makeUser("oidc-dup-legacy");
    const legacy = await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    // The pre-upgrade cookie carries the row id; it is honoured only while the
    // row has not yet retired its id in favour of a hashed secret.
    const resolved = await validateSessionFromCookieValue(legacy.id);
    expect(resolved?.user.id).toBe(user.id);
  });
});
