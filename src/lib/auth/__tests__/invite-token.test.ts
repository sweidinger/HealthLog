/**
 * v1.16.0 — invite-token consume-path unit tests.
 *
 * Pins the gate order against a mocked Prisma client:
 *   - shape gate (`looksLikeInviteToken`) short-circuits before any DB hit,
 *   - revoked > expired > exhausted refusal precedence,
 *   - the guarded-increment WHERE carries `revokedAt: null`,
 *   - `recordInviteConsumer` writes the `usedBy` stamp AND the
 *     redemption-ledger row in one transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const redemptionCreate = vi.fn();
const transaction = vi.fn(async (ops: unknown[]) => ops);

vi.mock("@/lib/db", () => ({
  prisma: {
    inviteToken: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
      update: (...args: unknown[]) => update(...args),
    },
    inviteRedemption: {
      create: (...args: unknown[]) => redemptionCreate(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...(args as [unknown[]])),
  },
}));

import {
  consumeInviteToken,
  generateInviteToken,
  looksLikeInviteToken,
  recordInviteConsumer,
} from "../invite-token";

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

function baseInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv1",
    expiresAt: FUTURE,
    uses: 0,
    maxUses: 1,
    revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.API_TOKEN_HMAC_KEY = "0".repeat(64);
});

describe("consumeInviteToken", () => {
  it("rejects malformed tokens before touching the DB", async () => {
    const result = await consumeInviteToken("not-a-token");
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("refuses a revoked invite ahead of every other state", async () => {
    findUnique.mockResolvedValue(
      baseInvite({ revokedAt: PAST, expiresAt: PAST, uses: 5, maxUses: 1 }),
    );
    const result = await consumeInviteToken(generateInviteToken());
    expect(result).toEqual({ ok: false, reason: "revoked" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses an expired invite", async () => {
    findUnique.mockResolvedValue(baseInvite({ expiresAt: PAST }));
    const result = await consumeInviteToken(generateInviteToken());
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses an exhausted invite", async () => {
    findUnique.mockResolvedValue(baseInvite({ uses: 1, maxUses: 1 }));
    const result = await consumeInviteToken(generateInviteToken());
    expect(result).toEqual({ ok: false, reason: "exhausted" });
  });

  it("consumes a valid invite with a revocation-guarded increment", async () => {
    findUnique.mockResolvedValue(baseInvite());
    updateMany.mockResolvedValue({ count: 1 });
    const result = await consumeInviteToken(generateInviteToken());
    expect(result).toEqual({ ok: true, inviteId: "inv1" });
    const where = updateMany.mock.calls[0][0].where;
    expect(where.revokedAt).toBeNull();
    expect(where.uses).toEqual({ lt: 1 });
  });

  it("treats a lost increment race as exhausted", async () => {
    findUnique.mockResolvedValue(baseInvite({ maxUses: 2, uses: 1 }));
    updateMany.mockResolvedValue({ count: 0 });
    const result = await consumeInviteToken(generateInviteToken());
    expect(result).toEqual({ ok: false, reason: "exhausted" });
  });
});

describe("recordInviteConsumer", () => {
  it("stamps usedBy and appends a redemption-ledger row", async () => {
    await recordInviteConsumer("inv1", "user1");
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "inv1" },
      data: { usedBy: "user1" },
    });
    expect(redemptionCreate).toHaveBeenCalledWith({
      data: { inviteId: "inv1", userId: "user1" },
    });
  });

  it("swallows failures — the use is already counted", async () => {
    transaction.mockRejectedValueOnce(new Error("boom"));
    await expect(recordInviteConsumer("inv1", "user1")).resolves.toBeUndefined();
  });
});

describe("looksLikeInviteToken", () => {
  it("accepts the generated shape and rejects near-misses", () => {
    expect(looksLikeInviteToken(generateInviteToken())).toBe(true);
    expect(looksLikeInviteToken("hlk_" + "a".repeat(64))).toBe(false);
    expect(looksLikeInviteToken("hlv_" + "a".repeat(63))).toBe(false);
    expect(looksLikeInviteToken("hlv_" + "G".repeat(64))).toBe(false);
  });
});
