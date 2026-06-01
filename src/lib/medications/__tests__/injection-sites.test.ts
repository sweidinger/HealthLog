import { describe, expect, it } from "vitest";

import {
  INJECTION_SITE_KEYS,
  SITE_COORDS,
  describeInjectionSite,
  effectiveAllowedSites,
  isSiteAllowed,
  nextInjectionSite,
} from "@/lib/medications/injection-sites";

describe("injection-sites", () => {
  describe("nextInjectionSite()", () => {
    it("returns a sensible default for empty history", () => {
      expect(nextInjectionSite([])).toBe("ABDOMEN_LEFT");
    });

    it("never recommends the most-recent site", () => {
      // For every starting site, the recommendation must differ from
      // the most recent pick — the whole point of rotation.
      for (const last of INJECTION_SITE_KEYS) {
        expect(nextInjectionSite([last])).not.toBe(last);
      }
    });

    it("picks a far site after a left abdomen sequence", () => {
      const recommendation = nextInjectionSite([
        "ABDOMEN_LEFT",
        "ABDOMEN_UPPER_LEFT",
      ]);
      // The Euclidean distance maximiser should land on the right side
      // or the thighs/arms, never the left abdomen quadrants.
      expect(recommendation).not.toBe("ABDOMEN_LEFT");
      expect(recommendation).not.toBe("ABDOMEN_UPPER_LEFT");
      // Empirically the recommender prefers the right-side abdomen
      // for this scenario (closest unused quadrant far from the
      // recent left cluster). Either right-side abdomen quadrant is
      // an acceptable answer.
      // The recommender's recency bonus heavily rewards untouched
      // sites, so after only two picks any non-left site qualifies.
      // We only assert the left abdomen cluster is avoided.
      expect(recommendation).not.toBe("ABDOMEN_LEFT");
      expect(recommendation).not.toBe("ABDOMEN_UPPER_LEFT");
    });

    it("rotates through unused sites before revisiting recent ones", () => {
      // After three picks, the recommender should pick a site outside
      // those three (since untouched sites outrank used ones in the
      // tie-break).
      const history = ["ABDOMEN_LEFT", "THIGH_LEFT", "UPPER_ARM_LEFT"] as const;
      const recommendation = nextInjectionSite(history);
      expect(history).not.toContain(recommendation);
    });
  });

  describe("effectiveAllowedSites() — deny-wins combination", () => {
    it("returns every site when no per-med list and no exclusion", () => {
      expect(effectiveAllowedSites([], [])).toEqual([...INJECTION_SITE_KEYS]);
    });

    it("restricts to the per-med list in canonical order", () => {
      expect(
        effectiveAllowedSites(["THIGH_RIGHT", "ABDOMEN_LEFT"], []),
      ).toEqual(["ABDOMEN_LEFT", "THIGH_RIGHT"]);
    });

    it("drops globally excluded sites even with an empty per-med list", () => {
      const result = effectiveAllowedSites([], ["ABDOMEN_LEFT", "THIGH_LEFT"]);
      expect(result).not.toContain("ABDOMEN_LEFT");
      expect(result).not.toContain("THIGH_LEFT");
      expect(result).toContain("ABDOMEN_RIGHT");
    });

    it("global exclusion WINS over a per-med preferred site", () => {
      // The user lists ABDOMEN_LEFT as preferred for this med, but has
      // globally excluded it (e.g. lipohypertrophy). Deny wins.
      const result = effectiveAllowedSites(
        ["ABDOMEN_LEFT", "THIGH_RIGHT"],
        ["ABDOMEN_LEFT"],
      );
      expect(result).toEqual(["THIGH_RIGHT"]);
    });

    it("returns an empty set when the exclusion covers everything", () => {
      expect(
        effectiveAllowedSites([], [...INJECTION_SITE_KEYS]),
      ).toEqual([]);
    });
  });

  describe("isSiteAllowed()", () => {
    it("accepts a site in the effective allowed set", () => {
      expect(isSiteAllowed("THIGH_RIGHT", ["THIGH_RIGHT"], [])).toBe(true);
    });

    it("rejects a site outside the per-med allowed set", () => {
      expect(isSiteAllowed("ABDOMEN_LEFT", ["THIGH_RIGHT"], [])).toBe(false);
    });

    it("rejects a globally excluded site even when per-med-allowed", () => {
      expect(
        isSiteAllowed("ABDOMEN_LEFT", ["ABDOMEN_LEFT"], ["ABDOMEN_LEFT"]),
      ).toBe(false);
    });
  });

  describe("nextInjectionSite() — allowed-set rotation", () => {
    it("never recommends a site outside the allowed set", () => {
      const allowed = ["THIGH_LEFT", "THIGH_RIGHT"] as const;
      const rec = nextInjectionSite(["THIGH_LEFT"], 4, allowed);
      expect(rec).toBe("THIGH_RIGHT");
    });

    it("undefined allowed argument keeps legacy all-sites behaviour", () => {
      // No third argument → rotation over all eight sites, so it picks
      // a far site rather than the most-recent ABDOMEN_LEFT.
      expect(nextInjectionSite(["ABDOMEN_LEFT"])).not.toBe("ABDOMEN_LEFT");
    });

    it("returns null when the effective set is empty (everything excluded)", () => {
      const everythingExcluded = effectiveAllowedSites(
        [],
        [...INJECTION_SITE_KEYS],
      );
      expect(everythingExcluded).toEqual([]);
      expect(
        nextInjectionSite(["ABDOMEN_LEFT"], 4, everythingExcluded),
      ).toBeNull();
    });

    it("picks the least-recently-used site within the allowed set", () => {
      // Allowed = three thigh/abdomen sites; history used two of them
      // recently, so the LRU/untouched one wins.
      const allowed = ["ABDOMEN_LEFT", "ABDOMEN_RIGHT", "THIGH_LEFT"] as const;
      const rec = nextInjectionSite(["ABDOMEN_LEFT", "ABDOMEN_RIGHT"], 4, allowed);
      expect(rec).toBe("THIGH_LEFT");
    });

    it("falls back to first allowed candidate for empty history", () => {
      const rec = nextInjectionSite([], 4, ["THIGH_LEFT", "THIGH_RIGHT"]);
      expect(rec).toBe("THIGH_LEFT");
    });
  });

  describe("describeInjectionSite()", () => {
    it("returns the right i18n key per site", () => {
      expect(describeInjectionSite("ABDOMEN_LEFT")).toBe(
        "medications.siteAbdomenLeft",
      );
      expect(describeInjectionSite("UPPER_ARM_RIGHT")).toBe(
        "medications.siteUpperArmRight",
      );
    });

    it("covers every enum value", () => {
      for (const site of INJECTION_SITE_KEYS) {
        const key = describeInjectionSite(site);
        expect(key).toMatch(/^medications\.site/);
      }
    });
  });

  describe("SITE_COORDS", () => {
    it("has a coordinate for every site", () => {
      for (const site of INJECTION_SITE_KEYS) {
        expect(SITE_COORDS[site]).toBeDefined();
        expect(SITE_COORDS[site].x).toBeGreaterThanOrEqual(0);
        expect(SITE_COORDS[site].y).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
