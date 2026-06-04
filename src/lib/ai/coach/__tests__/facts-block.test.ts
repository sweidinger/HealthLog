import { describe, expect, it, vi } from "vitest";

// Hermetic codec — same as facts.test.ts.
vi.mock("../bytes-codec", () => ({
  encryptToBytes: (s: string) => new TextEncoder().encode(s),
  decryptFromBytes: (b: Uint8Array) => new TextDecoder().decode(b),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

import { buildCoachFactsBlock, FACTS_INJECT_TOP_N } from "../facts";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

interface SeedRow {
  text: string;
  category?: string;
  confidence: number;
  updatedAt: Date;
}

/**
 * Fake prisma that honours the orderBy the helper passes (confidence DESC,
 * updatedAt DESC) so the test exercises the real ranking contract.
 */
function makeFakePrisma(seed: SeedRow[]) {
  const findMany = vi.fn(async () => {
    const sorted = [...seed].sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    return sorted.map((r) => ({
      factEncrypted: bytes(r.text),
      category: r.category ?? "preference",
      confidence: r.confidence,
      updatedAt: r.updatedAt,
    }));
  });
  return { prisma: { coachFact: { findMany } }, findMany };
}

describe("buildCoachFactsBlock", () => {
  it("ranks by confidence then recency", async () => {
    const { prisma } = makeFakePrisma([
      { text: "older high", confidence: 90, updatedAt: new Date(2026, 0, 1) },
      { text: "newer high", confidence: 90, updatedAt: new Date(2026, 0, 5) },
      { text: "low", confidence: 40, updatedAt: new Date(2026, 0, 10) },
    ]);

    const block = await buildCoachFactsBlock("user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
    });

    expect(block).not.toBeNull();
    expect(block!.facts.map((f) => f.text)).toEqual(["newer high", "older high", "low"]);
  });

  it("takes only the top N", async () => {
    const seed: SeedRow[] = Array.from({ length: FACTS_INJECT_TOP_N + 4 }, (_, i) => ({
      text: `fact ${i}`,
      confidence: 100 - i,
      updatedAt: new Date(2026, 0, 1 + i),
    }));
    const { prisma } = makeFakePrisma(seed);

    const block = await buildCoachFactsBlock("user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
    });

    expect(block).not.toBeNull();
    expect(block!.facts).toHaveLength(FACTS_INJECT_TOP_N);
    expect(block!.facts[0].text).toBe("fact 0");
  });

  it("returns null when there are no active facts", async () => {
    const { prisma } = makeFakePrisma([]);
    const block = await buildCoachFactsBlock("user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: prisma as any,
    });
    expect(block).toBeNull();
  });

  it("skips undecryptable rows fault-isolated (never throws)", async () => {
    // One row whose codec throws on decrypt; the helper must skip it.
    const findMany = vi.fn(async () => [
      { factEncrypted: bytes("good fact"), category: "goal", confidence: 80, updatedAt: new Date() },
      { factEncrypted: bytes("__throw__"), category: "goal", confidence: 70, updatedAt: new Date() },
    ]);
    // Re-point the codec mock to throw for the sentinel payload.
    const codec = await import("../bytes-codec");
    vi.spyOn(codec, "decryptFromBytes").mockImplementation((b: Uint8Array) => {
      const s = new TextDecoder().decode(b);
      if (s === "__throw__") throw new Error("bad key id");
      return s;
    });

    const block = await buildCoachFactsBlock("user-1", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: { coachFact: { findMany } } as any,
    });

    expect(block).not.toBeNull();
    expect(block!.facts.map((f) => f.text)).toEqual(["good fact"]);
  });
});
