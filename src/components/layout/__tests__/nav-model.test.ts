/**
 * v1.17.1 (F-1 / F-3) — the one navigation information-model.
 *
 * Pins the coherence contract the desktop sidebar and the mobile
 * bottom-nav both consume: one ordered destination list (so the two bars
 * tell one story), the Coach as a first-class destination on both
 * surfaces, cycle gated by the account flag, and an active-resolver that
 * prefers the most-specific sibling under `/insights`. (v1.18.0 —
 * Workouts and Recovery left the left nav for their Insights pills.)
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
  it("lists Coach as a first-class destination", () => {
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs).toContain("/coach");
  });

  it("gives the Coach exactly one nav home at the top-level /coach (F-3)", () => {
    const coach = NAV_DESTINATIONS.filter((d) => d.href === "/coach");
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
    // Peer to Labs: sits in the clinical spine, before Insights.
    expect(hrefs.indexOf("/labs")).toBeLessThan(hrefs.indexOf("/vorsorge"));
    expect(hrefs.indexOf("/vorsorge")).toBeLessThan(hrefs.indexOf("/insights"));
  });

  it("does not list Recovery as a left-nav destination (it is an Insights pill)", () => {
    // v1.18.0 — Recovery moved off the left nav and surfaces as an
    // Insights tab-strip pill at `/insights/recovery` instead.
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs).not.toContain("/insights/recovery");
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

describe("visibleNavDestinations module gate", () => {
  it("includes Cycle (between Medications and Insights) only when its module is enabled", () => {
    // v1.18.0 — cycle is `requiresModule: "cycle"` and reads the delegated
    // `cycle` key from the same resolved module map every other gate uses.
    const off = visibleNavDestinations({ cycle: false }).map((d) => d.href);
    const on = visibleNavDestinations({ cycle: true }).map((d) => d.href);
    expect(off).not.toContain("/cycle");
    expect(on).toContain("/cycle");
    expect(on.indexOf("/medications")).toBeLessThan(on.indexOf("/cycle"));
    expect(on.indexOf("/cycle")).toBeLessThan(on.indexOf("/insights"));
  });

  it("drops a module-gated entry (mood / labs / coach / achievements) when its module is disabled", () => {
    const disabled = visibleNavDestinations({
      mood: false,
      labs: false,
      coach: false,
      achievements: false,
    }).map((d) => d.href);
    expect(disabled).not.toContain("/mood");
    expect(disabled).not.toContain("/labs");
    expect(disabled).not.toContain("/coach");
    expect(disabled).not.toContain("/achievements");
  });

  it("keeps every module-gated entry when its module is enabled", () => {
    const enabled = visibleNavDestinations({
      mood: true,
      labs: true,
      coach: true,
      achievements: true,
    }).map((d) => d.href);
    expect(enabled).toContain("/mood");
    expect(enabled).toContain("/labs");
    expect(enabled).toContain("/coach");
    expect(enabled).toContain("/achievements");
  });

  it("fails open: a missing key or an undefined map keeps the gated entry", () => {
    // Default-on contract — a stale /me payload (no module map) must not
    // blank the nav. An empty map and `undefined` both keep every entry.
    const emptyMap = visibleNavDestinations({}).map((d) => d.href);
    const noMap = visibleNavDestinations(undefined).map((d) => d.href);
    for (const hrefs of [emptyMap, noMap]) {
      expect(hrefs).toContain("/mood");
      expect(hrefs).toContain("/cycle");
      expect(hrefs).toContain("/labs");
      expect(hrefs).toContain("/coach");
      expect(hrefs).toContain("/achievements");
    }
    // Core destinations always render regardless of the map.
    expect(emptyMap).toContain("/measurements");
    expect(emptyMap).toContain("/medications");
    expect(emptyMap).toContain("/insights");
    expect(emptyMap).toContain("/vorsorge");
  });
});

describe("mobileMoreHubDestinations — the F-1 mobile invariant (N-2)", () => {
  it("is exactly the visible feature destinations minus the primary slots, then the utility tail", () => {
    const opts = {
      modules: { cycle: false } as const,
      bugReportEnabled: false,
    };
    const hub = mobileMoreHubDestinations(opts).map((d) => d.href);

    const expectedFeatures = visibleNavDestinations(opts.modules)
      .map((d) => d.href)
      .filter((href) => !BOTTOM_NAV_PRIMARY_SLOT_HREFS.includes(href));
    const expectedTail = visibleUtilityDestinations(
      opts.bugReportEnabled,
    ).map((d) => d.href);

    expect(hub).toEqual([...expectedFeatures, ...expectedTail]);
  });

  it("never contains a primary slot (Home / Meds / Insights)", () => {
    const hub = mobileMoreHubDestinations({
      modules: { cycle: true },
      bugReportEnabled: true,
    }).map((d) => d.href);
    for (const slot of BOTTOM_NAV_PRIMARY_SLOT_HREFS) {
      expect(hub).not.toContain(slot);
    }
  });

  it("keeps the feature destinations and the utility tail reachable in the hub", () => {
    const hub = mobileMoreHubDestinations({
      modules: { cycle: false },
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

  it("gates Cycle by the module map and Bug Report by the operator flag, same as the sidebar", () => {
    const off = mobileMoreHubDestinations({
      modules: { cycle: false, mood: false },
      bugReportEnabled: false,
    }).map((d) => d.href);
    const on = mobileMoreHubDestinations({
      modules: { cycle: true, mood: true },
      bugReportEnabled: true,
    }).map((d) => d.href);
    expect(off).not.toContain("/cycle");
    expect(off).not.toContain("/mood");
    expect(off).not.toContain("/bugreport");
    expect(on).toContain("/cycle");
    expect(on).toContain("/mood");
    expect(on).toContain("/bugreport");
  });
});

describe("isNavDestinationActive most-specific resolution", () => {
  it("matches the dashboard only on an exact path", () => {
    expect(isNavDestinationActive("/", "/")).toBe(true);
    expect(isNavDestinationActive("/", "/measurements")).toBe(false);
  });

  it("lights up the top-level Coach home on its own route", () => {
    expect(isNavDestinationActive("/coach", "/coach")).toBe(true);
    // The standalone /coach route is not a sibling of /insights, so the
    // Insights entry must stay dark on it.
    expect(isNavDestinationActive("/insights", "/coach")).toBe(false);
  });

  it("lights up Insights on its Workouts sub-route (no longer a separate nav home)", () => {
    // v1.18.0 — Workouts left the left nav for its Insights pill, so it is
    // no longer a more-specific NAV_DESTINATIONS sibling. The Insights nav
    // home now reads active on `/insights/workouts`, like any other
    // `/insights/*` sub-route.
    expect(isNavDestinationActive("/insights", "/insights/workouts")).toBe(
      true,
    );
  });

  it("still lights up Insights on its own sub-routes", () => {
    expect(isNavDestinationActive("/insights", "/insights")).toBe(true);
    expect(isNavDestinationActive("/insights", "/insights/values/WEIGHT")).toBe(
      true,
    );
  });
});
