/**
 * v1.17.1 — onboarding goal slug enum + dashboard seeding.
 *
 * Goals are a personalization seed, not a clinical target store: the
 * only leverage they have is which dashboard tiles get promoted and
 * made visible. These tests pin (a) the closed slug guard and (b) the
 * one-time seed builder's promote/forces-visible/no-op contracts.
 */
import { describe, it, expect } from "vitest";

import {
  ONBOARDING_GOAL_SLUGS,
  GOAL_WIDGET_SEED_MAP,
  isOnboardingGoalSlug,
  buildGoalSeededDashboardLayout,
} from "../goals";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";

describe("isOnboardingGoalSlug", () => {
  it("accepts every member of the closed slug set", () => {
    for (const slug of ONBOARDING_GOAL_SLUGS) {
      expect(isOnboardingGoalSlug(slug)).toBe(true);
    }
  });

  it("rejects unknown / non-string values", () => {
    expect(isOnboardingGoalSlug("not-a-goal")).toBe(false);
    expect(isOnboardingGoalSlug("")).toBe(false);
    expect(isOnboardingGoalSlug(null)).toBe(false);
    expect(isOnboardingGoalSlug(42)).toBe(false);
  });
});

describe("GOAL_WIDGET_SEED_MAP", () => {
  it("only maps to ids the dashboard layout actually knows", () => {
    const known = new Set<DashboardWidgetId>(
      DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) => w.id as DashboardWidgetId),
    );
    for (const ids of Object.values(GOAL_WIDGET_SEED_MAP)) {
      for (const id of ids) expect(known.has(id)).toBe(true);
    }
  });

  it("leaves general-wellness without a tile preference", () => {
    expect(GOAL_WIDGET_SEED_MAP["general-wellness"]).toEqual([]);
  });
});

describe("buildGoalSeededDashboardLayout", () => {
  it("returns null for an empty selection (no seed)", () => {
    expect(buildGoalSeededDashboardLayout([])).toBeNull();
  });

  it("returns null for a general-wellness-only selection", () => {
    expect(buildGoalSeededDashboardLayout(["general-wellness"])).toBeNull();
  });

  it("ignores unknown slugs and seeds nothing when only unknowns are passed", () => {
    expect(buildGoalSeededDashboardLayout(["bogus", "nope"])).toBeNull();
  });

  it("promotes glucose to the top and forces it visible", () => {
    const layout = buildGoalSeededDashboardLayout(["glucose-tracking"]);
    expect(layout).not.toBeNull();
    const widgets = layout!.widgets;
    // glucose is default-invisible + ordered low; the seed lifts it to
    // order 0 and turns both surfaces on.
    const glucose = widgets.find((w) => w.id === "glucose");
    expect(glucose).toMatchObject({
      order: 0,
      visible: true,
      tileVisible: true,
    });
  });

  it("promotes every mapped tile for a multi-goal selection", () => {
    const layout = buildGoalSeededDashboardLayout([
      "weight-management",
      "bp-tracking",
    ]);
    expect(layout).not.toBeNull();
    const widgets = layout!.widgets;
    const promotedIds = new Set(["weight", "bodyFat", "bp", "bpInTarget"]);
    // Every promoted id sits in the leading block and is visible.
    for (const id of promotedIds) {
      const w = widgets.find((x) => x.id === id);
      expect(w?.visible).toBe(true);
      expect(w?.tileVisible).toBe(true);
      expect(w!.order).toBeLessThan(promotedIds.size);
    }
  });

  it("keeps a dense, complete widget set (no tiles dropped)", () => {
    const layout = buildGoalSeededDashboardLayout(["sleep-improvement"]);
    expect(layout!.widgets.length).toBe(
      DEFAULT_DASHBOARD_LAYOUT.widgets.length,
    );
    const orders = layout!.widgets.map((w) => w.order).sort((a, b) => a - b);
    expect(orders).toEqual(orders.map((_, i) => i));
  });
});
