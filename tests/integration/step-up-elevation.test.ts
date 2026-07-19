/**
 * Behavioural suite for token-bound step-up elevations, against a real Postgres
 * and the real gate — no mocked Prisma, no mocked auth.
 *
 * This mechanism lets a Bearer token reach a surface that has been cookie-only
 * since v1.23, so the cases below are written as attacks rather than as happy
 * paths. Each one must fail closed if its protection is removed; a green suite
 * over a broken gate would be worse than no suite at all.
 *
 * Two of them need a real database to mean anything. Single-use atomicity is a
 * claim about what Postgres does when two writers race the same row, and the
 * unit mocks cannot produce that race — E3b runs the two redemptions genuinely
 * concurrently against one connection pool. The token binding is a claim about a
 * WHERE clause, and only a real query proves the clause is in it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-step-up-elevation-32-bytes-minimum-1234567890";

const { hashToken } = await import("@/lib/auth/hmac");
const { hashPassword } = await import("@/lib/auth/password");

const USER_ID = "user-step-up-test";
const OTHER_USER_ID = "user-step-up-other";
const PASSWORD = "correct horse battery staple 42";

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
  const passwordHash = await hashPassword(PASSWORD);
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "step-up",
      email: "step-up@example.test",
      timezone: "UTC",
      passwordHash,
    },
  });
  await getPrismaClient().user.create({
    data: {
      id: OTHER_USER_ID,
      username: "step-up-other",
      email: "step-up-other@example.test",
      timezone: "UTC",
      passwordHash,
    },
  });
});

/** Mint a real wildcard `ApiToken` row. Does NOT arm the header. */
async function mintToken(
  label: string,
  userId = USER_ID,
): Promise<{ raw: string; id: string }> {
  const raw = `hlk_${label}${"0".repeat(64 - label.length)}`;
  const row = await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: label,
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
    select: { id: true },
  });
  return { raw, id: row.id };
}

function useToken(raw: string): void {
  headerJar.set("authorization", `Bearer ${raw}`);
}

function useElevation(raw: string | null): void {
  if (raw === null) headerJar.delete("x-step-up");
  else headerJar.set("x-step-up", raw);
}

function req(path: string, method = "GET", body?: unknown): NextRequest {
  const headers: Record<string, string> = {};
  const auth = headerJar.get("authorization");
  if (auth) headers.authorization = auth;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new NextRequest(`https://health.example${path}`, init as never);
}

/** Drive the mint endpoint with a password proof. */
async function mintElevation(
  password: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import("@/app/api/auth/step-up/route");
  const res = await POST(
    req("/api/auth/step-up", "POST", { method: "password", password }),
  );
  return { status: res.status, body: (await res.json()) as never };
}

/** GET /api/auth/me/mfa — the cheapest route in the elevation-accepting set. */
async function callMfaStatus(): Promise<Response> {
  const { GET } = await import("@/app/api/auth/me/mfa/route");
  return await GET(req("/api/auth/me/mfa"));
}

async function auditReasons(action: string): Promise<string[]> {
  const rows = await getPrismaClient().auditLog.findMany({
    where: { action },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(
    (r) => (JSON.parse(r.details ?? "{}") as { reason?: string }).reason ?? "",
  );
}

// ── E1 — a stolen token, on its own, gains nothing ───────────────────

describe("E1 — the token alone is not a step-up proof", () => {
  it("refuses an MFA-management call with no elevation header", async () => {
    const { raw } = await mintToken("e1a");
    useToken(raw);
    useElevation(null);

    const res = await callMfaStatus();

    // 401 with the machine code the client branches on to launch a re-proof —
    // not a 200, and not the 403 an unauthorised token would get.
    expect(res.status).toBe(401);
  });

  it("mints nothing when the body carries no factor proof", async () => {
    const { raw } = await mintToken("e1b");
    useToken(raw);

    const { POST } = await import("@/app/api/auth/step-up/route");
    const res = await POST(req("/api/auth/step-up", "POST", {}));

    expect(res.status).toBe(422);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });

  it("refuses a fabricated elevation value", async () => {
    const { raw } = await mintToken("e1c");
    useToken(raw);
    useElevation(`hle_${"f".repeat(64)}`);

    expect((await callMfaStatus()).status).toBe(401);
    await new Promise((r) => setTimeout(r, 100));
    expect(await auditReasons("auth.stepup.elevation.rejected")).toContain(
      "unknown",
    );
  });
});

// ── E2 — the elevation is bound to one token ─────────────────────────

describe("E2 — an elevation is not portable between tokens", () => {
  it("refuses redemption by a second token of the SAME user", async () => {
    const a = await mintToken("e2a");
    const b = await mintToken("e2b");

    useToken(a.raw);
    const minted = await mintElevation(PASSWORD);
    expect(minted.status).toBe(200);
    const elevation = (minted.body.data as { elevation: string }).elevation;

    // Same account, same scopes, different token row. The binding is the only
    // thing standing between these two, which is exactly the point.
    useToken(b.raw);
    useElevation(elevation);
    const res = await callMfaStatus();

    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 100));
    expect(await auditReasons("auth.stepup.elevation.rejected")).toContain(
      "wrong_token",
    );

    // And the legitimate holder's elevation survived the attempt.
    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row?.consumedAt).toBeNull();

    useToken(a.raw);
    useElevation(elevation);
    expect((await callMfaStatus()).status).toBe(200);
  });

  it("refuses redemption by another user's token", async () => {
    const mine = await mintToken("e2c");
    const theirs = await mintToken("e2d", OTHER_USER_ID);

    useToken(mine.raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    useToken(theirs.raw);
    useElevation(elevation);

    expect((await callMfaStatus()).status).toBe(401);
  });
});

// ── E3 — single use, including under concurrency ─────────────────────

describe("E3 — an elevation is consumed exactly once", () => {
  it("refuses a second sequential redemption", async () => {
    const { raw } = await mintToken("e3a");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    useElevation(elevation);
    expect((await callMfaStatus()).status).toBe(200);
    expect((await callMfaStatus()).status).toBe(401);

    await new Promise((r) => setTimeout(r, 100));
    expect(await auditReasons("auth.stepup.elevation.rejected")).toContain(
      "consumed",
    );
  });

  it("lets exactly one of two CONCURRENT redemptions win", async () => {
    const { raw, id } = await mintToken("e3b");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    // Straight at the redemption primitive, so the race is between two real
    // conditional UPDATEs on one row rather than between two HTTP handlers that
    // happen to interleave. A check-then-update implementation passes the
    // sequential case above and fails here.
    const { redeemStepUpElevation } = await import("@/lib/auth/step-up");
    const attempt = () =>
      redeemStepUpElevation({
        rawToken: elevation,
        userId: USER_ID,
        apiTokenId: id,
      });

    const results = await Promise.all([
      attempt(),
      attempt(),
      attempt(),
      attempt(),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(3);
  });
});

// ── E4 — expiry ──────────────────────────────────────────────────────

describe("E4 — an expired elevation is refused", () => {
  it("refuses one whose window has passed", async () => {
    const { raw, id } = await mintToken("e4a");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    // Age the row rather than the clock: the expiry lives in the redemption's
    // WHERE clause, so this is the honest way to exercise it.
    await getPrismaClient().stepUpElevation.updateMany({
      where: { apiTokenId: id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    useElevation(elevation);
    expect((await callMfaStatus()).status).toBe(401);

    await new Promise((r) => setTimeout(r, 100));
    expect(await auditReasons("auth.stepup.elevation.rejected")).toContain(
      "expired",
    );
  });

  it("mints a five-minute window, matching the cookie step-up", async () => {
    const { raw } = await mintToken("e4b");
    useToken(raw);
    const { body } = await mintElevation(PASSWORD);
    const data = body.data as { expiresInSeconds: number };

    const { MFA_STEP_UP_MAX_AGE_SECONDS } = await import("@/lib/api-handler");
    expect(data.expiresInSeconds).toBe(MFA_STEP_UP_MAX_AGE_SECONDS);
  });
});

// ── E5 — the elevation cannot reach admin ────────────────────────────

describe("E5 — an elevation does not satisfy requireAdmin", () => {
  it("refuses an admin route even for an ADMIN user holding a valid elevation", async () => {
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { role: "ADMIN" },
    });

    const { raw } = await mintToken("e5a");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;
    useElevation(elevation);

    const { GET } = await import("@/app/api/admin/users/route");
    const res = await GET(req("/api/admin/users"));

    // Cookie-only, and the elevation is not a cookie. The account being a
    // genuine admin is what makes this test worth having: the refusal is the
    // transport, not the role.
    expect(res.status).toBe(401);

    // Unconsumed — the admin gate never even looked at it.
    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row?.consumedAt).toBeNull();
  });
});

// ── E6 — a wrong password mints nothing, is throttled, is audited ────

describe("E6 — the mint refuses, throttles, and records a bad password", () => {
  it("returns a generic 401 and writes no row", async () => {
    const { raw } = await mintToken("e6a");
    useToken(raw);

    const res = await mintElevation("not the password");

    expect(res.status).toBe(401);
    // Same prose for every cause — the response must not say whether the
    // password was wrong or the account has none.
    expect(res.body.error).toBe("Verification failed");
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });

  it("is indistinguishable from an account with no password set", async () => {
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { passwordHash: null },
    });
    const { raw } = await mintToken("e6b");
    useToken(raw);

    const res = await mintElevation("anything at all");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Verification failed");
  });

  it("audits the failure with the real reason", async () => {
    const { raw } = await mintToken("e6c");
    useToken(raw);
    await mintElevation("wrong");

    const rows = await getPrismaClient().auditLog.findMany({
      where: { action: "auth.stepup.mint.failed" },
    });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details ?? "{}")).toMatchObject({
      method: "password",
      reason: "bad_password",
    });
  });

  it("throttles a guessing run", async () => {
    const { raw } = await mintToken("e6d");
    useToken(raw);

    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await mintElevation(`guess-${i}`)).status);
    }

    // Five attempts per fifteen minutes, then the bucket closes — the same
    // ceiling the password-change route uses, for the same Argon2id reason.
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);

    // And the throttle holds even once the caller finds the right password.
    expect((await mintElevation(PASSWORD)).status).toBe(429);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });
});

// ── E7 — the web path is untouched ───────────────────────────────────

describe("E7 — the cookie flow is unchanged", () => {
  async function useCookieSession(userId = USER_ID): Promise<string> {
    const session = await getPrismaClient().session.create({
      data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    return session.id;
  }

  it("serves an MFA-management read on a plain cookie session", async () => {
    await useCookieSession();
    expect((await callMfaStatus()).status).toBe(200);
  });

  it("still refuses a step-up-gated route on a cookie with no fresh factor", async () => {
    await useCookieSession();
    const { POST } =
      await import("@/app/api/auth/me/mfa/recovery-codes/regenerate/route");
    const res = await POST(
      req("/api/auth/me/mfa/recovery-codes/regenerate", "POST"),
    );
    expect(res.status).toBe(401);
  });

  it("admits a step-up-gated route on a freshly verified cookie session", async () => {
    const sessionId = await useCookieSession();
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { totpConfirmedAt: new Date() },
    });
    await getPrismaClient().session.update({
      where: { id: sessionId },
      data: { mfaVerifiedAt: new Date() },
    });

    const { POST } =
      await import("@/app/api/auth/me/mfa/recovery-codes/regenerate/route");
    const res = await POST(
      req("/api/auth/me/mfa/recovery-codes/regenerate", "POST"),
    );
    expect(res.status).toBe(200);
  });

  it("ignores an elevation header when a cookie session is present", async () => {
    // The cookie branch returns before the header is ever read. Proven by the
    // elevation surviving unconsumed.
    const { raw, id } = await mintToken("e7a");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    await useCookieSession();
    useElevation(elevation);
    expect((await callMfaStatus()).status).toBe(200);

    const row = await getPrismaClient().stepUpElevation.findFirst({
      where: { apiTokenId: id },
    });
    expect(row?.consumedAt).toBeNull();
  });
});

// ── E8 — invalidation on credential rotation ─────────────────────────

describe("E8 — an elevation does not outlive its anchor", () => {
  it("is dropped when the account password changes", async () => {
    const { raw } = await mintToken("e8a");
    useToken(raw);
    await mintElevation(PASSWORD);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(1);

    const { revokeStepUpElevations } = await import("@/lib/auth/step-up");
    await revokeStepUpElevations(USER_ID);

    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });

  it("is unredeemable once the bound token is revoked", async () => {
    const { raw, id } = await mintToken("e8b");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    await getPrismaClient().apiToken.update({
      where: { id },
      data: { revoked: true },
    });

    useElevation(elevation);
    // Refused at Bearer resolution, before the elevation is even looked at —
    // which is why no code in the revoke path needs to know about elevations.
    expect((await callMfaStatus()).status).toBe(401);

    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row?.consumedAt).toBeNull();
  });

  it("is cascade-deleted with the token row", async () => {
    const { raw, id } = await mintToken("e8c");
    useToken(raw);
    await mintElevation(PASSWORD);

    await getPrismaClient().apiToken.delete({ where: { id } });

    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });
});

// ── E9 — the happy path actually works end to end ────────────────────

describe("E9 — a native client can manage its second factor", () => {
  it("mints, redeems, and enrols TOTP", async () => {
    const { raw } = await mintToken("e9a");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    useElevation(elevation);
    const { POST } = await import("@/app/api/auth/me/mfa/totp/setup/route");
    const res = await POST(req("/api/auth/me/mfa/totp/setup", "POST"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { totpSecret: string; otpauthUri: string };
    };
    expect(body.data.totpSecret).toBeTruthy();
    expect(body.data.otpauthUri).toMatch(/^otpauth:\/\//);

    // The pending secret landed, and the elevation is spent — a second action
    // needs a second proof.
    const user = await getPrismaClient().user.findUnique({
      where: { id: USER_ID },
    });
    expect(user?.totpSecretEncrypted).toBeTruthy();
    expect(user?.totpConfirmedAt).toBeNull();
    expect((await callMfaStatus()).status).toBe(401);
  });

  it("refuses the mint surface to a cookie session", async () => {
    const session = await getPrismaClient().session.create({
      data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    headerJar.delete("authorization");

    const { POST } = await import("@/app/api/auth/step-up/route");
    const res = await POST(
      req("/api/auth/step-up", "POST", {
        method: "password",
        password: PASSWORD,
      }),
    );

    expect(res.status).toBe(401);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });
});
