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
  BOTTOM_NAV_PRIMARY_SLOT_HREFS,
  NAV_DESTINATIONS,
  NAV_UTILITY_DESTINATIONS,
  isNavDestinationActive,
  mobileMoreHubDestinations,
  visibleNavDestinations,
  visibleUtilityDestinations,
} from "../nav-model";

describe("nav-model destination list", () => {
  it("lists Workouts and Coach as first-class destinations", () => {
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs).toContain("/insights/workouts");
    expect(hrefs).toContain("/insights/coach");
  });

  it("gives the Coach exactly one nav home (F-3)", () => {
    const coach = NAV_DESTINATIONS.filter(
      (d) => d.href === "/insights/coach",
    );
    expect(coach).toHaveLength(1);
    expect(coach[0]!.tKey).toBe("nav.coach");
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

  it("gives Vorsorge a top-level nav home in the clinical spine (N-3)", () => {
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs).toContain("/vorsorge");
    const vorsorge = NAV_DESTINATIONS.find((d) => d.href === "/vorsorge");
    expect(vorsorge?.tKey).toBe("nav.vorsorge");
    // Peer to Labs / Recovery: sits in the clinical spine, before Insights.
    expect(hrefs.indexOf("/labs")).toBeLessThan(hrefs.indexOf("/vorsorge"));
    expect(hrefs.indexOf("/vorsorge")).toBeLessThan(hrefs.indexOf("/insights"));
  });

});

describe("nav-model utility tail (N-1 — one shared list)", () => {
  it("every utility destination carries a nav-namespace i18n key", () => {
    for (const d of NAV_UTILITY_DESTINATIONS) {
      expect(d.tKey.startsWith("nav.")).toBe(true);
    }
  });

  it("lists the shared utility surfaces (Bug Report, Settings, Notifications)", () => {
    const hrefs = NAV_UTILITY_DESTINATIONS.map((d) => d.href);
    expect(hrefs).toContain("/bugreport");
    expect(hrefs).toContain("/settings/account");
    expect(hrefs).toContain("/notifications");
  });

  it("drops the bug-report entry unless the operator flag is on", () => {
    const off = visibleUtilityDestinations(false).map((d) => d.href);
    const on = visibleUtilityDestinations(true).map((d) => d.href);
    expect(off).not.toContain("/bugreport");
    expect(on).toContain("/bugreport");
    // Non-gated entries are present either way.
    expect(off).toContain("/settings/account");
    expect(off).toContain("/notifications");
  });

  it("keeps a stable order (Bug Report → Settings → Notifications)", () => {
    const hrefs = visibleUtilityDestinations(true).map((d) => d.href);
    expect(hrefs.indexOf("/bugreport")).toBeLessThan(
      hrefs.indexOf("/settings/account"),
    );
    expect(hrefs.indexOf("/settings/account")).toBeLessThan(
      hrefs.indexOf("/notifications"),
    );
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

describe("mobileMoreHubDestinations — the F-1 mobile invariant (N-2)", () => {
  it("is exactly the visible feature destinations minus the primary slots, then the utility tail", () => {
    const opts = { cycleTrackingEnabled: false, bugReportEnabled: false };
    const hub = mobileMoreHubDestinations(opts).map((d) => d.href);

    const expectedFeatures = visibleNavDestinations(opts.cycleTrackingEnabled)
      .map((d) => d.href)
      .filter((href) => !BOTTOM_NAV_PRIMARY_SLOT_HREFS.includes(href));
    const expectedTail = visibleUtilityDestinations(
      opts.bugReportEnabled,
    ).map((d) => d.href);

    expect(hub).toEqual([...expectedFeatures, ...expectedTail]);
  });

  it("never contains a primary slot (Home / Meds / Insights)", () => {
    const hub = mobileMoreHubDestinations({
      cycleTrackingEnabled: true,
      bugReportEnabled: true,
    }).map((d) => d.href);
    for (const slot of BOTTOM_NAV_PRIMARY_SLOT_HREFS) {
      expect(hub).not.toContain(slot);
    }
  });

  it("keeps the feature destinations and the utility tail reachable in the hub", () => {
    const hub = mobileMoreHubDestinations({
      cycleTrackingEnabled: false,
      bugReportEnabled: true,
    }).map((d) => d.href);
    // Feature surfaces that left the always-visible strip stay reachable.
    expect(hub).toContain("/measurements");
    expect(hub).toContain("/mood");
    expect(hub).toContain("/vorsorge");
    // The shared utility tail rides at the end.
    expect(hub).toContain("/bugreport");
    expect(hub).toContain("/settings/account");
    expect(hub).toContain("/notifications");
  });

  it("gates Cycle and Bug Report by the same flags the sidebar uses", () => {
    const off = mobileMoreHubDestinations({
      cycleTrackingEnabled: false,
      bugReportEnabled: false,
    }).map((d) => d.href);
    const on = mobileMoreHubDestinations({
      cycleTrackingEnabled: true,
      bugReportEnabled: true,
    }).map((d) => d.href);
    expect(off).not.toContain("/cycle");
    expect(off).not.toContain("/bugreport");
    expect(on).toContain("/cycle");
    expect(on).toContain("/bugreport");
  });
});

describe("isNavDestinationActive most-specific resolution", () => {
  it("matches the dashboard only on an exact path", () => {
    expect(isNavDestinationActive("/", "/")).toBe(true);
    expect(isNavDestinationActive("/", "/measurements")).toBe(false);
  });

  it("does not light up Insights when on its Coach sibling", () => {
    expect(isNavDestinationActive("/insights/coach", "/insights/coach")).toBe(
      true,
    );
    expect(isNavDestinationActive("/insights", "/insights/coach")).toBe(false);
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
