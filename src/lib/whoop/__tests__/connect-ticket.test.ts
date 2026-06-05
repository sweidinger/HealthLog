import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/hmac", () => ({
  // Deterministic stand-in so the test can assert hash binding without the
  // real HMAC key. `hash(<raw>)` => `h:<raw>`.
  hashToken: (raw: string) => `h:${raw}`,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    whoopConnectTicket: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

import {
  WHOOP_CONNECT_TICKET_TTL_MS,
  mintWhoopConnectTicket,
  consumeWhoopConnectTicket,
} from "../connect-ticket";
import { prisma } from "@/lib/db";

const create = prisma.whoopConnectTicket.create as ReturnType<typeof vi.fn>;
const updateMany = prisma.whoopConnectTicket.updateMany as ReturnType<
  typeof vi.fn
>;
const findUnique = prisma.whoopConnectTicket.findUnique as ReturnType<
  typeof vi.fn
>;

describe("WHOOP connect ticket", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pins a ~60s TTL", () => {
    expect(WHOOP_CONNECT_TICKET_TTL_MS).toBe(60 * 1000);
  });

  it("mints an opaque ticket and stores ONLY its hash, never the raw value", async () => {
    create.mockResolvedValue({});
    const before = Date.now();
    const raw = await mintWhoopConnectTicket("u1");

    // Opaque, high-entropy, URL-safe.
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0].data;
    expect(arg.userId).toBe("u1");
    expect(arg.tokenHash).toBe(`h:${raw}`);
    // The raw ticket must NOT be persisted in any plaintext column — only the
    // (here-stubbed) hash carries it. The row has exactly userId/tokenHash/
    // expiresAt; no field equals the raw value.
    expect(Object.keys(arg).sort()).toEqual([
      "expiresAt",
      "tokenHash",
      "userId",
    ]);
    for (const [key, value] of Object.entries(arg)) {
      if (key === "tokenHash") continue;
      expect(value).not.toBe(raw);
    }
    expect(arg.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + WHOOP_CONNECT_TICKET_TTL_MS - 50,
    );
  });

  it("consumes a valid ticket atomically and resolves the user", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue({ userId: "u1" });

    const res = await consumeWhoopConnectTicket("raw-ticket");
    expect(res).toEqual({ userId: "u1" });

    // Atomic single-use: the WHERE pins unconsumed + unexpired, the data
    // stamps consumedAt in the same statement.
    const where = updateMany.mock.calls[0][0].where;
    expect(where.tokenHash).toBe("h:raw-ticket");
    expect(where.consumedAt).toBeNull();
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    expect(updateMany.mock.calls[0][0].data.consumedAt).toBeInstanceOf(Date);
  });

  it("rejects reuse / expired / unknown (updateMany matches 0 rows)", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const res = await consumeWhoopConnectTicket("already-used");
    expect(res).toBeNull();
    // Never re-reads the user when nothing was consumed.
    expect(findUnique).not.toHaveBeenCalled();
  });
});
