import { describe, expect, it } from "vitest";

import { launchScopeToCoachScope } from "../coach-conversation";
import {
  metricScopeFromExplainer,
  scopeSourceFromMetricKey,
} from "../../coach-metric-scope";

/**
 * v1.21.0 (C4 H1/H4) — the Coach launch scope is now live. These tests pin
 * the conversion from the UI launch scope to the chat route's wire
 * `CoachScope`, plus the two metric→source resolvers that feed it.
 */
describe("launchScopeToCoachScope", () => {
  it("returns undefined for an absent / metric-less scope (default snapshot)", () => {
    expect(launchScopeToCoachScope(null)).toBeUndefined();
    expect(launchScopeToCoachScope(undefined)).toBeUndefined();
    expect(launchScopeToCoachScope({})).toBeUndefined();
  });

  it("maps a single metric to a one-source scope", () => {
    expect(launchScopeToCoachScope({ metric: "bp" })).toEqual({
      sources: ["bp"],
    });
  });

  it("includes `also` sources and dedupes against the primary", () => {
    expect(
      launchScopeToCoachScope({ metric: "bp", also: ["compliance", "bp"] }),
    ).toEqual({ sources: ["bp", "compliance"] });
  });

  it("threads the window through only when present", () => {
    expect(
      launchScopeToCoachScope({ metric: "hrv", window: "last7days" }),
    ).toEqual({ sources: ["hrv"], window: "last7days" });
    expect(launchScopeToCoachScope({ metric: "hrv" })).not.toHaveProperty(
      "window",
    );
  });
});

describe("metricScopeFromExplainer", () => {
  it("resolves a mapped explainer token to a scope + opener", () => {
    const resolved = metricScopeFromExplainer("bloodPressure");
    expect(resolved?.metric).toBe("bp");
    expect(resolved?.question).toMatch(/blood pressure/i);
  });

  it("anchors the recovery page on its driver sources + short window", () => {
    const resolved = metricScopeFromExplainer("recoveryPage");
    expect(resolved?.metric).toBe("hrv");
    expect(resolved?.also).toEqual(["resting_hr", "sleep"]);
    expect(resolved?.window).toBe("last7days");
  });

  it("returns null for an unmapped / undefined token", () => {
    expect(metricScopeFromExplainer("walkingAsymmetry")).toBeNull();
    expect(metricScopeFromExplainer(undefined)).toBeNull();
  });
});

describe("scopeSourceFromMetricKey", () => {
  it("maps the model's snapshot-key vocabulary to a scope source", () => {
    expect(scopeSourceFromMetricKey("bloodPressure")).toBe("bp");
    expect(scopeSourceFromMetricKey("medications.compliance30")).toBe(
      "compliance",
    );
    expect(scopeSourceFromMetricKey("WEIGHT")).toBe("weight");
  });

  it("returns null for an unknown / absent key", () => {
    expect(scopeSourceFromMetricKey("vascular_age")).toBeNull();
    expect(scopeSourceFromMetricKey(undefined)).toBeNull();
  });
});
