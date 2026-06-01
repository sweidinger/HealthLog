import { describe, expect, it } from "vitest";

import { resolveInjectionSiteForWrite } from "@/lib/medications/injection-site-write";

const base = {
  taken: true,
  deliveryForm: "INJECTION",
  trackInjectionSites: true,
  allowedInjectionSites: [] as const,
  globalExcludedInjectionSites: [] as const,
};

describe("resolveInjectionSiteForWrite()", () => {
  it("persists a valid site on a taken injection with tracking on", () => {
    const r = resolveInjectionSiteForWrite({ ...base, submitted: "THIGH_LEFT" });
    expect(r).toEqual({ kind: "ok", site: "THIGH_LEFT" });
  });

  it("drops the site when the medication is not an INJECTION", () => {
    const r = resolveInjectionSiteForWrite({
      ...base,
      deliveryForm: "ORAL",
      submitted: "THIGH_LEFT",
    });
    expect(r).toEqual({ kind: "ok", site: null });
  });

  it("drops the site when tracking is disabled (default-off)", () => {
    const r = resolveInjectionSiteForWrite({
      ...base,
      trackInjectionSites: false,
      submitted: "THIGH_LEFT",
    });
    expect(r).toEqual({ kind: "ok", site: null });
  });

  it("drops the site on a skipped write (optional, never blocking)", () => {
    const r = resolveInjectionSiteForWrite({
      ...base,
      taken: false,
      submitted: "THIGH_LEFT",
    });
    expect(r).toEqual({ kind: "ok", site: null });
  });

  it("treats an omitted site as no-site (optional capture)", () => {
    const r = resolveInjectionSiteForWrite({ ...base, submitted: undefined });
    expect(r).toEqual({ kind: "ok", site: null });
  });

  it("rejects a site outside the per-medication allowed set (422)", () => {
    const r = resolveInjectionSiteForWrite({
      ...base,
      allowedInjectionSites: ["THIGH_RIGHT"],
      submitted: "ABDOMEN_LEFT",
    });
    expect(r).toEqual({ kind: "disallowed", site: "ABDOMEN_LEFT" });
  });

  it("rejects a globally excluded site even when per-med-preferred (deny wins)", () => {
    const r = resolveInjectionSiteForWrite({
      ...base,
      allowedInjectionSites: ["ABDOMEN_LEFT"],
      globalExcludedInjectionSites: ["ABDOMEN_LEFT"],
      submitted: "ABDOMEN_LEFT",
    });
    expect(r).toEqual({ kind: "disallowed", site: "ABDOMEN_LEFT" });
  });

  it("accepts a per-med-allowed site that is not globally excluded", () => {
    const r = resolveInjectionSiteForWrite({
      ...base,
      allowedInjectionSites: ["ABDOMEN_LEFT", "THIGH_RIGHT"],
      globalExcludedInjectionSites: ["ABDOMEN_LEFT"],
      submitted: "THIGH_RIGHT",
    });
    expect(r).toEqual({ kind: "ok", site: "THIGH_RIGHT" });
  });
});
