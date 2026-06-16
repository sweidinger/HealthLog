/**
 * v1.18.1 P4 — Rest Mode resolver.
 *
 * Rest Mode ANNOTATES, never penalises. These tests pin the resolver
 * contract: module-gated (a disabled / opted-out account is never in Rest
 * Mode and does no episode read), the fold to the renderable context, and the
 * fail-soft behaviour (a read error reads as "not in Rest Mode" so a Rest Mode
 * annotation can never break the payload it rides on).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ isIllnessEnabled: vi.fn() }));
const db = vi.hoisted(() => ({
  prisma: { illnessEpisode: { findMany: vi.fn() } },
}));

vi.mock("@/lib/illness/gate", () => gate);
vi.mock("@/lib/db", () => db);

import {
  getActiveIllnessEpisodes,
  resolveRestMode,
  toRestModeContext,
  REST_MODE_INACTIVE,
} from "@/lib/illness/rest-mode";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getActiveIllnessEpisodes", () => {
  it("returns [] without a read when the illness module is disabled", async () => {
    gate.isIllnessEnabled.mockResolvedValue(false);
    await expect(getActiveIllnessEpisodes("u1")).resolves.toEqual([]);
    expect(db.prisma.illnessEpisode.findMany).not.toHaveBeenCalled();
  });

  it("queries only active (unresolved, not-deleted, onset ≤ asOf) episodes when enabled", async () => {
    gate.isIllnessEnabled.mockResolvedValue(true);
    db.prisma.illnessEpisode.findMany.mockResolvedValue([]);
    const asOf = new Date("2026-06-16T00:00:00.000Z");
    await getActiveIllnessEpisodes("u1", asOf);
    const arg = db.prisma.illnessEpisode.findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      userId: "u1",
      deletedAt: null,
      resolvedAt: null,
      onsetAt: { lte: asOf },
    });
  });
});

describe("toRestModeContext", () => {
  it("folds an empty set to the inactive context", () => {
    expect(toRestModeContext([])).toEqual(REST_MODE_INACTIVE);
  });

  it("anchors `since` on the earliest onset and counts episodes (no note leaks)", () => {
    const ctx = toRestModeContext([
      {
        id: "e1",
        label: "Erkältung",
        type: "INFECTION",
        lifecycle: "ACUTE",
        onsetAt: new Date("2026-06-10T00:00:00.000Z"),
      },
      {
        id: "e2",
        label: "Heuschnupfen",
        type: "ALLERGY",
        lifecycle: "RECURRING",
        onsetAt: new Date("2026-06-14T00:00:00.000Z"),
      },
    ]);
    expect(ctx.active).toBe(true);
    expect(ctx.episodeCount).toBe(2);
    expect(ctx.since).toBe("2026-06-10T00:00:00.000Z");
    // The context carries labels + lifecycle only — no free-text note field.
    expect(ctx.episodes[0]).not.toHaveProperty("note");
    expect(Object.keys(ctx.episodes[0]).sort()).toEqual([
      "id",
      "label",
      "lifecycle",
      "onsetAt",
      "type",
    ]);
  });
});

describe("resolveRestMode", () => {
  it("resolves active context from the active episodes", async () => {
    gate.isIllnessEnabled.mockResolvedValue(true);
    db.prisma.illnessEpisode.findMany.mockResolvedValue([
      {
        id: "e1",
        label: "Erkältung",
        type: "INFECTION",
        lifecycle: "ACUTE",
        onsetAt: new Date("2026-06-10T00:00:00.000Z"),
      },
    ]);
    const ctx = await resolveRestMode("u1");
    expect(ctx.active).toBe(true);
    expect(ctx.episodeCount).toBe(1);
  });

  it("is fail-soft: a read error reads as not-in-Rest-Mode", async () => {
    gate.isIllnessEnabled.mockResolvedValue(true);
    db.prisma.illnessEpisode.findMany.mockRejectedValue(new Error("boom"));
    await expect(resolveRestMode("u1")).resolves.toEqual(REST_MODE_INACTIVE);
  });

  it("is inactive (no read) for a disabled module", async () => {
    gate.isIllnessEnabled.mockResolvedValue(false);
    await expect(resolveRestMode("u1")).resolves.toEqual(REST_MODE_INACTIVE);
  });
});
