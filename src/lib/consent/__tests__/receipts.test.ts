import { describe, it, expect, vi, beforeEach } from "vitest";

// `createReceipt` + `revokeLatest` run their supersede/revoke logic inside
// a transaction. Run the callback against the same mock proxy. The Prisma
// `$transaction` signature is generic; the mock takes a loose callback.
type TxFn = (tx: unknown) => unknown;

vi.mock("@/lib/db", () => {
  const consentReceipt = {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  return {
    prisma: {
      consentReceipt,
      $transaction: vi.fn((fn: TxFn) => fn({ consentReceipt })),
    },
  };
});

import { prisma } from "@/lib/db";
import {
  createReceipt,
  latestActiveReceipt,
  latestActiveReceiptsByKind,
  revokeLatest,
} from "../receipts";

const $transaction = vi.mocked(prisma.$transaction) as unknown as {
  mockImplementation: (impl: (fn: TxFn) => unknown) => void;
};

beforeEach(() => {
  vi.resetAllMocks();
  $transaction.mockImplementation((fn: TxFn) =>
    fn({ consentReceipt: prisma.consentReceipt }),
  );
});

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rcpt-1",
    userId: "user-1",
    kind: "ai_full",
    artefact: "PDF…",
    signedAt: new Date("2026-05-18T10:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-05-18T10:00:01.000Z"),
    ...overrides,
  };
}

describe("createReceipt", () => {
  it("supersedes any active row then inserts scoped to (userId, kind)", async () => {
    vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    vi.mocked(prisma.consentReceipt.create).mockResolvedValue(row() as never);

    const signedAt = new Date("2026-05-18T10:00:00.000Z");
    const result = await createReceipt("user-1", "ai_full", "PDF…", signedAt);

    // Revokes any currently-active receipt of the same kind first, so the
    // fresh grant doesn't collide with the partial unique index.
    expect(prisma.consentReceipt.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
      data: { revokedAt: signedAt },
    });
    expect(prisma.consentReceipt.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        kind: "ai_full",
        artefact: "PDF…",
        signedAt,
      },
    });
    expect(result.id).toBe("rcpt-1");
    // The whole mint runs in a transaction.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("latestActiveReceipt", () => {
  it("filters by user + kind + revokedAt:null and orders by createdAt desc", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(row() as never);

    const result = await latestActiveReceipt("user-1", "ai_full");

    expect(prisma.consentReceipt.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    expect(result?.id).toBe("rcpt-1");
  });

  it("returns null when no active receipt exists", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(null);

    const result = await latestActiveReceipt("user-1", "ai_full");

    expect(result).toBeNull();
  });
});

describe("latestActiveReceiptsByKind", () => {
  it("returns the freshest row per kind (first-wins over createdAt desc)", async () => {
    vi.mocked(prisma.consentReceipt.findMany).mockResolvedValue([
      row({ id: "fresh-coach", kind: "ai_coach" }),
      row({ id: "fresh-full", kind: "ai_full" }),
      // Older `ai_full` row — must be ignored because we already saw
      // the freshest one above (the mock list is pre-sorted desc).
      row({ id: "older-full", kind: "ai_full" }),
    ] as never);

    const result = await latestActiveReceiptsByKind("user-1");

    expect(result.ai_full?.id).toBe("fresh-full");
    expect(result.ai_coach?.id).toBe("fresh-coach");
    expect(result.ai_insights_only).toBeUndefined();
  });
});

describe("revokeLatest", () => {
  it("atomically revokes the active row via updateMany and returns it", async () => {
    const now = new Date("2026-05-18T11:00:00.000Z");
    vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(
      row({ revokedAt: now }) as never,
    );

    const result = await revokeLatest("user-1", "ai_full", now);

    expect(prisma.consentReceipt.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
      data: { revokedAt: now },
    });
    // Re-reads the just-revoked row so the audit log keeps the receipt id.
    expect(prisma.consentReceipt.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: now },
      orderBy: { createdAt: "desc" },
    });
    expect(result?.revokedAt).toEqual(now);
  });

  it("returns null without re-reading when no active receipt exists", async () => {
    vi.mocked(prisma.consentReceipt.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    const result = await revokeLatest("user-1", "ai_full");

    expect(result).toBeNull();
    expect(prisma.consentReceipt.findFirst).not.toHaveBeenCalled();
  });
});
