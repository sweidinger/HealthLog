/**
 * v1.20.0 (F1) — the DATA INVENTORY manifest: it must mark present/absent per
 * domain from the snapshot's sections, carry restMode + cycleEnabled, and
 * render a compact, brand-free, grounding-honest block. The model reads this to
 * know what is fetchable so it never invents a metric.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { CoachSnapshotResult } from "@/lib/ai/coach/snapshot";

const buildCoachSnapshot = vi.fn<() => Promise<CoachSnapshotResult>>();
const isCycleAvailableForUser = vi.fn<() => Promise<boolean>>();

vi.mock("@/lib/ai/coach/snapshot", () => ({
  buildCoachSnapshot: () => buildCoachSnapshot(),
}));
vi.mock("@/lib/cycle/gate", () => ({
  isCycleAvailableForUser: () => isCycleAvailableForUser(),
}));

import {
  buildCoachDataInventory,
  renderDataInventory,
} from "@/lib/ai/coach/tools/inventory";

function snapshot(
  sections: Record<string, unknown>,
  counts?: Record<string, number>,
): CoachSnapshotResult {
  return {
    snapshotJson: JSON.stringify(sections),
    sections,
    provenance: {
      windows: [],
      metrics: [],
      ...(counts ? { counts: counts as never } : {}),
    },
    referenceGrounding: null,
  };
}

describe("buildCoachDataInventory", () => {
  beforeEach(() => {
    buildCoachSnapshot.mockReset();
    isCycleAvailableForUser.mockReset();
    isCycleAvailableForUser.mockResolvedValue(false);
  });

  it("marks present domains and carries counts + window", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot(
        {
          bloodPressure: { aggregate: {} },
          glucose: { byContext: {} },
          scope: { window: "last7days" },
        },
        { bp: 42, glucose: 100 },
      ),
    );
    const inv = await buildCoachDataInventory("u1", { window: "last7days" });
    expect(inv.window).toBe("last7days");
    const bp = inv.entries.find((e) => e.metric === "bp");
    expect(bp).toMatchObject({ present: true, count: 42 });
    const glucose = inv.entries.find((e) => e.tool === "get_glucose_panel");
    expect(glucose).toMatchObject({ present: true, count: 100 });
    const sleep = inv.entries.find((e) => e.tool === "get_sleep");
    expect(sleep?.present).toBe(false);
  });

  it("advertises workouts + correlations tools and the cycle tool when enabled", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot(
        {
          workouts: { recent: [], totalInWindow: 4 },
          mood: {},
          cycle: { phase: "luteal" },
          scope: { window: "last30days" },
        },
        { workouts: 4 },
      ),
    );
    isCycleAvailableForUser.mockResolvedValue(true);
    const inv = await buildCoachDataInventory("u1", undefined);
    const workouts = inv.entries.find((e) => e.tool === "get_workouts");
    expect(workouts).toMatchObject({ present: true, count: 4 });
    const correlations = inv.entries.find((e) => e.tool === "get_correlations");
    expect(correlations?.present).toBe(true); // mood present → correlatable
    const cycle = inv.entries.find((e) => e.tool === "get_cycle");
    expect(cycle).toMatchObject({ present: true });
  });

  it("omits the cycle line when cycle tracking is unavailable", async () => {
    buildCoachSnapshot.mockResolvedValue(snapshot({ bloodPressure: {} }));
    isCycleAvailableForUser.mockResolvedValue(false);
    const inv = await buildCoachDataInventory("u1", undefined);
    expect(inv.entries.find((e) => e.tool === "get_cycle")).toBeUndefined();
  });

  it("probes a wide source set so synced domains are advertised", async () => {
    // body composition + spo2 present even though they are not default clusters.
    buildCoachSnapshot.mockResolvedValue(
      snapshot(
        { bodyFat: {}, oxygenSaturation: {}, scope: { window: "last30days" } },
        { body_fat: 12, spo2: 30 },
      ),
    );
    const inv = await buildCoachDataInventory("u1", undefined);
    const bodyFat = inv.entries.find((e) => e.metric === "body_fat");
    const spo2 = inv.entries.find((e) => e.metric === "spo2");
    expect(bodyFat).toMatchObject({ present: true, count: 12 });
    expect(spo2).toMatchObject({ present: true, count: 30 });
  });

  it("reports restMode + cycleEnabled", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot({ illness: { restMode: true } }),
    );
    isCycleAvailableForUser.mockResolvedValue(true);
    const inv = await buildCoachDataInventory("u1", undefined);
    expect(inv.restMode).toBe(true);
    expect(inv.cycleEnabled).toBe(true);
  });
});

describe("renderDataInventory", () => {
  it("renders a grounding-honest, brand-free block", async () => {
    buildCoachSnapshot.mockResolvedValue(
      snapshot(
        { bloodPressure: {}, scope: { window: "last30days" } },
        { bp: 5 },
      ),
    );
    isCycleAvailableForUser.mockResolvedValue(false);
    const inv = await buildCoachDataInventory("u1", undefined);
    const text = renderDataInventory(inv);
    expect(text).toContain("DATA INVENTORY");
    expect(text).toContain("Never cite a figure you did not fetch");
    expect(text).toContain("blood pressure: present → get_metric_series");
    // brand-free: no vendor names.
    expect(text.toLowerCase()).not.toContain("withings");
    expect(text.toLowerCase()).not.toContain("oura");
    expect(text.toLowerCase()).not.toContain("whoop");
  });
});
