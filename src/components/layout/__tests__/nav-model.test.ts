/**
 * v1.17.1 (F-1 / F-3) — the one navigation information-model.
 *
 * Pins the coherence contract the desktop sidebar and the mobile
 * bottom-nav both consume: one ordered destination list (so the two bars
 * tell one story), Workouts AND Coach as first-class destinations on both
 * surfaces, cycle gated by the account flag, and an active-resolver that
 * prefers the most-specific sibling under `/insights`.
 */
import { describe, expect, it } from "vitest";

import {
  NAV_DESTINATIONS,
  isNavDestinationActive,
  visibleNavDestinations,
} from "../nav-model";

describe("nav-model destination list", () => {
  it("lists Workouts as a first-class destination on both surfaces", () => {
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs).toContain("/insights/workouts");
  });

  it("orders the core spine: dashboard → measurements → mood → medications", () => {
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs.indexOf("/")).toBeLessThan(hrefs.indexOf("/measurements"));
    expect(hrefs.indexOf("/measurements")).toBeLessThan(
      hrefs.indexOf("/mood"),
    );
    expect(hrefs.indexOf("/mood")).toBeLessThan(
      hrefs.indexOf("/medications"),
    );
  });

  it("every destination carries an i18n key under the nav namespace", () => {
    for (const d of NAV_DESTINATIONS) {
      expect(d.tKey.startsWith("nav.")).toBe(true);
    }
  });

});

describe("visibleNavDestinations cycle gate", () => {
  it("includes Cycle (between Medications and Insights) only when enabled", () => {
    const off = visibleNavDestinations(false).map((d) => d.href);
    const on = visibleNavDestinations(true).map((d) => d.href);
    expect(off).not.toContain("/cycle");
    expect(on).toContain("/cycle");
    expect(on.indexOf("/medications")).toBeLessThan(on.indexOf("/cycle"));
    expect(on.indexOf("/cycle")).toBeLessThan(on.indexOf("/insights"));
  });
});

describe("isNavDestinationActive most-specific resolution", () => {
  it("matches the dashboard only on an exact path", () => {
    expect(isNavDestinationActive("/", "/")).toBe(true);
    expect(isNavDestinationActive("/", "/measurements")).toBe(false);
  });

  it("does not light up Insights when on its Workouts sibling", () => {
    expect(
      isNavDestinationActive("/insights/workouts", "/insights/workouts"),
    ).toBe(true);
    expect(isNavDestinationActive("/insights", "/insights/workouts")).toBe(
      false,
    );
  });

  it("still lights up Insights on its own sub-routes", () => {
    expect(isNavDestinationActive("/insights", "/insights")).toBe(true);
    expect(isNavDestinationActive("/insights", "/insights/values/WEIGHT")).toBe(
      true,
    );
  });
});
