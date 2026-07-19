/**
 * Unit-level checks on the elevation primitive that need no database.
 *
 * The behavioural work — binding, single use, expiry, the concurrent race —
 * lives in `tests/integration/step-up-elevation.test.ts`, because every one of
 * those claims is a claim about what Postgres does with a WHERE clause and a
 * mocked client cannot answer it. What is worth pinning here is the pair of
 * constants that must not drift apart, and the shape of the value the mint
 * hands out.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    stepUpElevation: {
      create: vi.fn().mockResolvedValue({ id: "elevation-1" }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-step-up-unit-32-bytes-minimum-abcdefghijklmnop";

const {
  mintStepUpElevation,
  redeemStepUpElevation,
  STEP_UP_ELEVATION_TTL_SECONDS,
} = await import("@/lib/auth/step-up");
const { MFA_STEP_UP_MAX_AGE_SECONDS } = await import("@/lib/api-handler");

describe("the two step-up windows stay pinned together", () => {
  it("matches the cookie path's freshness window exactly", () => {
    // If these ever diverge, the looser transport quietly becomes the way in.
    // Changing one is a decision; changing one by accident is a hole.
    expect(STEP_UP_ELEVATION_TTL_SECONDS).toBe(MFA_STEP_UP_MAX_AGE_SECONDS);
  });
});

describe("the minted value", () => {
  it("is a prefixed 32-byte CSPRNG secret, and the plaintext never reaches the row", async () => {
    const { prisma } = await import("@/lib/db");
    const { token } = await mintStepUpElevation({
      userId: "u1",
      apiTokenId: "t1",
      method: "password",
    });

    expect(token).toMatch(/^hle_[0-9a-f]{64}$/);

    const created = vi.mocked(prisma.stepUpElevation.create).mock.calls[0][0];
    const stored = (created.data as { tokenHash: string }).tokenHash;
    expect(stored).not.toContain(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs on every mint", async () => {
    const a = await mintStepUpElevation({
      userId: "u1",
      apiTokenId: "t1",
      method: "password",
    });
    const b = await mintStepUpElevation({
      userId: "u1",
      apiTokenId: "t1",
      method: "password",
    });
    expect(a.token).not.toBe(b.token);
  });
});

describe("redemption rejects a wrong-shaped value before touching the database", () => {
  it("refuses a value carrying another credential's prefix", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.stepUpElevation.updateMany).mockClear();

    // `hls_` is the session cookie secret and `hlk_` an access token. Neither
    // is an elevation, and neither should cost a query to find that out.
    for (const value of [
      `hls_${"a".repeat(64)}`,
      `hlk_${"a".repeat(64)}`,
      "",
    ]) {
      const result = await redeemStepUpElevation({
        rawToken: value,
        userId: "u1",
        apiTokenId: "t1",
      });
      expect(result).toEqual({ ok: false, reason: "malformed" });
    }

    expect(prisma.stepUpElevation.updateMany).not.toHaveBeenCalled();
  });
});

describe("the elevation header name is stable", () => {
  it("is the lowercase form the gate reads", async () => {
    const { STEP_UP_ELEVATION_HEADER } = await import("@/lib/api-handler");
    // Header lookups in the gate go through `headers().get()`, which is
    // case-insensitive; the constant is lowercase so a direct Map-backed test
    // jar matches it too.
    expect(STEP_UP_ELEVATION_HEADER).toBe("x-step-up");
    expect(STEP_UP_ELEVATION_HEADER).toBe(
      STEP_UP_ELEVATION_HEADER.toLowerCase(),
    );
  });
});
