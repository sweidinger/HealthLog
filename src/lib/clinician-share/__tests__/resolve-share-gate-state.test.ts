/**
 * v1.18.7 — share-link gate state (the page's gate-vs-render decision).
 *
 * Asserts: a legacy (null passphraseHash) live link resolves WITHOUT a gate;
 * a protected link surfaces its passphraseHash for the gate; revoked / expired
 * / unknown / malformed tokens all resolve to null (the same blunt 404); the
 * gate resolver NEVER bumps access counters (no `update` call).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    clinicianShareLink: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: (s: string) => `hash(${s})` }));

import { resolveShareGateState } from "../resolve-share-token";
import { prisma } from "@/lib/db";

const findUnique = prisma.clinicianShareLink.findUnique as ReturnType<
  typeof vi.fn
>;
const update = prisma.clinicianShareLink.update as ReturnType<typeof vi.fn>;

const VALID_TOKEN = `hls_${"a".repeat(48)}`;

function row(overrides: Record<string, unknown> = {}) {
  return {
    passphraseHash: "stored-hash",
    revokedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveShareGateState", () => {
  it("returns null for a malformed token (no DB hit)", async () => {
    expect(await resolveShareGateState("nope")).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns null for an unknown token", async () => {
    findUnique.mockResolvedValue(null);
    expect(await resolveShareGateState(VALID_TOKEN)).toBeNull();
  });

  it("returns null for a revoked link", async () => {
    findUnique.mockResolvedValue(row({ revokedAt: new Date() }));
    expect(await resolveShareGateState(VALID_TOKEN)).toBeNull();
  });

  it("returns null for an expired link", async () => {
    findUnique.mockResolvedValue(
      row({ expiresAt: new Date(Date.now() - 1000) }),
    );
    expect(await resolveShareGateState(VALID_TOKEN)).toBeNull();
  });

  it("surfaces the passphraseHash for a protected live link", async () => {
    findUnique.mockResolvedValue(row({ passphraseHash: "stored-hash" }));
    const gate = await resolveShareGateState(VALID_TOKEN);
    expect(gate).toEqual({
      tokenHash: `hash(${VALID_TOKEN})`,
      passphraseHash: "stored-hash",
    });
  });

  it("resolves a legacy (null passphraseHash) live link WITHOUT a gate", async () => {
    findUnique.mockResolvedValue(row({ passphraseHash: null }));
    const gate = await resolveShareGateState(VALID_TOKEN);
    expect(gate).not.toBeNull();
    expect(gate!.passphraseHash).toBeNull();
  });

  it("never bumps the access counter (no update)", async () => {
    findUnique.mockResolvedValue(row());
    await resolveShareGateState(VALID_TOKEN);
    expect(update).not.toHaveBeenCalled();
  });
});
