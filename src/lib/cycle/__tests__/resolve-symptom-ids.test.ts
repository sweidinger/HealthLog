/**
 * v1.15.1 — `resolveSymptomIds` resolves a mix of seeded catalogue keys AND
 * the caller's own `custom:` keys (the day-log write path for custom symptoms).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  cycleSymptom: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));
vi.mock("@/lib/cycle/profile", () => ({
  getOrCreateCycleProfile: vi.fn(),
}));

import { resolveSymptomIds } from "@/lib/cycle/day-log-write";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveSymptomIds", () => {
  it("queries the catalogue (userId null) AND the caller's own rows", async () => {
    db.cycleSymptom.findMany.mockResolvedValue([
      { id: "cs_cramps", key: "cramps" },
      { id: "id_custom", key: "custom:abc" },
    ]);

    const out = await resolveSymptomIds("user-1", ["cramps", "custom:abc"]);

    expect(out).toEqual([
      { key: "cramps", id: "cs_cramps" },
      { key: "custom:abc", id: "id_custom" },
    ]);
    const where = db.cycleSymptom.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ userId: null }, { userId: "user-1" }]);
    expect(where.key.in).toEqual(["cramps", "custom:abc"]);
    expect(where.isActive).toBe(true);
  });

  it("drops unknown keys (returns only resolved rows)", async () => {
    db.cycleSymptom.findMany.mockResolvedValue([
      { id: "id_custom", key: "custom:abc" },
    ]);
    const out = await resolveSymptomIds("user-1", [
      "custom:abc",
      "custom:not-mine",
    ]);
    expect(out).toEqual([{ key: "custom:abc", id: "id_custom" }]);
  });

  it("short-circuits on an empty key set", async () => {
    const out = await resolveSymptomIds("user-1", []);
    expect(out).toEqual([]);
    expect(db.cycleSymptom.findMany).not.toHaveBeenCalled();
  });
});
