import { describe, it, expect, vi, beforeEach } from "vitest";

// Real Argon2id hashing (a handful of codes is fast enough for a unit test)
// so the hash/verify round-trip is exercised end-to-end. Only the DB is mocked.
vi.mock("@/lib/db", () => ({
  prisma: {
    mfaRecoveryCode: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      // The transactional helper receives the same mocked client.
      const { prisma } = await import("@/lib/db");
      return fn(prisma);
    }),
  },
}));

import {
  generateRecoveryCodes,
  regenerateRecoveryCodes,
  verifyAndConsumeRecoveryCode,
  normaliseRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "../recovery-codes";
import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recovery-codes", () => {
  it("generates the configured count of high-entropy, grouped codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    }
    // No duplicates in a batch.
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("verifies a code once then refuses it (one-time use)", async () => {
    const code = "ABCDE-FGHJK";
    const codeHash = await hashPassword(normaliseRecoveryCode(code));

    vi.mocked(prisma.mfaRecoveryCode.findMany).mockResolvedValue([
      { id: "row-1", codeHash },
    ] as never);
    // First consume succeeds — the guarded update flips exactly one row.
    vi.mocked(prisma.mfaRecoveryCode.updateMany).mockResolvedValueOnce({
      count: 1,
    } as never);

    const first = await verifyAndConsumeRecoveryCode("user-1", code);
    expect(first).toBe(true);

    // Second attempt: the row is now used, so findMany returns nothing.
    vi.mocked(prisma.mfaRecoveryCode.findMany).mockResolvedValue([] as never);
    const second = await verifyAndConsumeRecoveryCode("user-1", code);
    expect(second).toBe(false);
  });

  it("treats a lost claim race (count !== 1) as a miss", async () => {
    const code = "ABCDE-FGHJK";
    const codeHash = await hashPassword(normaliseRecoveryCode(code));
    vi.mocked(prisma.mfaRecoveryCode.findMany).mockResolvedValue([
      { id: "row-1", codeHash },
    ] as never);
    vi.mocked(prisma.mfaRecoveryCode.updateMany).mockResolvedValueOnce({
      count: 0,
    } as never);

    expect(await verifyAndConsumeRecoveryCode("user-1", code)).toBe(false);
  });

  it("rejects a code that matches no stored hash", async () => {
    const realHash = await hashPassword(normaliseRecoveryCode("AAAAA-BBBBB"));
    vi.mocked(prisma.mfaRecoveryCode.findMany).mockResolvedValue([
      { id: "row-1", codeHash: realHash },
    ] as never);
    expect(await verifyAndConsumeRecoveryCode("user-1", "ZZZZZ-99999")).toBe(
      false,
    );
    expect(prisma.mfaRecoveryCode.updateMany).not.toHaveBeenCalled();
  });

  it("regeneration deletes the entire prior set before inserting", async () => {
    vi.mocked(prisma.mfaRecoveryCode.deleteMany).mockResolvedValue({
      count: 10,
    } as never);
    vi.mocked(prisma.mfaRecoveryCode.createMany).mockResolvedValue({
      count: 10,
    } as never);

    const codes = await regenerateRecoveryCodes("user-1");
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(prisma.mfaRecoveryCode.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    // Delete is ordered before the insert.
    const deleteOrder = vi.mocked(prisma.mfaRecoveryCode.deleteMany).mock
      .invocationCallOrder[0];
    const insertOrder = vi.mocked(prisma.mfaRecoveryCode.createMany).mock
      .invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(insertOrder);
  });
});
