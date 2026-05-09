import { describe, it, expect } from "vitest";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  resolveDashboardLayout,
  serializeDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

/**
 * v1.4.15 Fix 5 — Dashboard layout: top tiles selectable.
 *
 * Until v1.4.14 the layout schema had a single `visible` flag per
 * widget that controlled BOTH the upper-row strip tile AND the lower-
 * row chart for the same metric. Marc wanted them as independent
 * toggles so a user could keep the chart on for tracking but hide
 * the tile (or vice versa). v1.4.15 introduces an optional
 * `tileVisible` field; the resolver mirrors it from `visible` for
 * legacy saved layouts so users see no behavioural change until they
 * explicitly flip the new switch.
 */

describe("resolveDashboardLayout() — tileVisible upgrade", () => {
  it("mirrors tileVisible from visible for legacy layouts (no field saved)", () => {
    const legacy = {
      version: 1,
      widgets: [
        // No tileVisible field — saved before v1.4.15.
        { id: "weight", visible: true, order: 0 },
        { id: "bp", visible: false, order: 1 },
      ],
    };
    const resolved = resolveDashboardLayout(legacy);
    const weight = resolved.widgets.find((w) => w.id === "weight");
    const bp = resolved.widgets.find((w) => w.id === "bp");
    // tileVisible mirrors visible — preserves v1.4.14 single-toggle behaviour.
    expect(weight?.tileVisible).toBe(true);
    expect(bp?.tileVisible).toBe(false);
  });

  it("respects an explicit tileVisible value when present", () => {
    const layout = {
      version: 1,
      widgets: [
        // Explicit tileVisible different from visible — user opted in
        // to v1.4.15's split control, so the resolver MUST keep both
        // values intact.
        { id: "weight", visible: true, tileVisible: false, order: 0 },
        { id: "mood", visible: false, tileVisible: true, order: 1 },
      ],
    };
    const resolved = resolveDashboardLayout(layout);
    const weight = resolved.widgets.find((w) => w.id === "weight");
    const mood = resolved.widgets.find((w) => w.id === "mood");
    expect(weight?.visible).toBe(true);
    expect(weight?.tileVisible).toBe(false);
    expect(mood?.visible).toBe(false);
    expect(mood?.tileVisible).toBe(true);
  });

  it("auto-appends new widgets with tileVisible: false", () => {
    const partial = {
      version: 1,
      // Only weight — every other widget should auto-append from defaults.
      widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
    };
    const resolved = resolveDashboardLayout(partial);
    const sleep = resolved.widgets.find((w) => w.id === "sleep");
    expect(sleep).toBeDefined();
    // Auto-appended widgets default to invisible on both surfaces so a
    // user must opt in to see them after a schema upgrade.
    expect(sleep?.visible).toBe(false);
    expect(sleep?.tileVisible).toBe(false);
  });

  it("defaults the layout when raw input is null / not an object", () => {
    expect(resolveDashboardLayout(null)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    expect(resolveDashboardLayout(undefined)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });
});

describe("serializeDashboardLayout() — tileVisible persistence", () => {
  it("persists tileVisible explicitly so a re-read keeps the user's choice", () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [
        // User toggled tileVisible to false but kept the chart visible.
        { id: "weight", visible: true, tileVisible: false, order: 0 },
      ],
    };
    const serialized = serializeDashboardLayout(layout);
    expect(serialized.widgets[0].tileVisible).toBe(false);
    expect(serialized.widgets[0].visible).toBe(true);
  });

  it("derives tileVisible from visible when the field is missing on input", () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [
        // Field omitted — serialize must not produce undefined; mirror.
        { id: "weight", visible: true, order: 0 },
      ],
    };
    const serialized = serializeDashboardLayout(layout);
    expect(serialized.widgets[0].tileVisible).toBe(true);
  });

  it("normalizes order to 0-based dense", () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [
        { id: "weight", visible: true, tileVisible: true, order: 5 },
        { id: "bp", visible: true, tileVisible: true, order: 12 },
      ],
    };
    const serialized = serializeDashboardLayout(layout);
    expect(serialized.widgets.map((w) => w.order)).toEqual([0, 1]);
  });
});
