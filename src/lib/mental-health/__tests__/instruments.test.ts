import { describe, it, expect } from "vitest";

import {
  INSTRUMENTS,
  scoreTotal,
  severityBand,
  isSafetyFlagged,
} from "../instruments";

/**
 * v1.25.0 — pin the highest-consequence numbers in the release: the PHQ-9 /
 * GAD-7 totals, the validated severity-band edges (5 / 10 / 15 / 20 and
 * 5 / 10 / 15), the ≥10 action threshold, and the item-9 ANY-non-zero safety
 * flag. A future off-by-one on any band edge or the safety predicate must fail
 * here. Ground truth: Kroenke 2001 (PHQ-9) / Spitzer 2006 (GAD-7), mirrored in
 * `.planning/research/v125/clinical-instruments.md`.
 */
describe("mental-health instruments", () => {
  describe("scoreTotal", () => {
    it("sums the item answers", () => {
      expect(scoreTotal([0, 1, 2, 3, 0, 1, 2, 3, 1])).toBe(13);
      expect(scoreTotal([0, 0, 0, 0, 0, 0, 0])).toBe(0);
    });

    it("returns the max when every item is 3", () => {
      expect(scoreTotal(Array(9).fill(3))).toBe(27); // PHQ-9 max
      expect(scoreTotal(Array(7).fill(3))).toBe(21); // GAD-7 max
    });
  });

  describe("severityBand — PHQ-9 edges (0–4 / 5–9 / 10–14 / 15–19 / 20–27)", () => {
    const cases: Array<[number, string]> = [
      [0, "minimal"],
      [4, "minimal"],
      [5, "mild"],
      [9, "mild"],
      [10, "moderate"],
      [14, "moderate"],
      [15, "modSevere"],
      [19, "modSevere"],
      [20, "severe"],
      [27, "severe"],
    ];
    it.each(cases)("PHQ9 total %i → %s", (total, band) => {
      expect(severityBand("PHQ9", total)).toBe(band);
    });
  });

  describe("severityBand — GAD-7 edges (0–4 / 5–9 / 10–14 / 15–21)", () => {
    const cases: Array<[number, string]> = [
      [0, "minimal"],
      [4, "minimal"],
      [5, "mild"],
      [9, "mild"],
      [10, "moderate"],
      [14, "moderate"],
      [15, "severe"],
      [21, "severe"],
    ];
    it.each(cases)("GAD7 total %i → %s", (total, band) => {
      expect(severityBand("GAD7", total)).toBe(band);
    });
  });

  describe("action threshold is ≥10 for both instruments", () => {
    it("PHQ-9", () => {
      expect(INSTRUMENTS.PHQ9.actionThreshold).toBe(10);
    });
    it("GAD-7", () => {
      expect(INSTRUMENTS.GAD7.actionThreshold).toBe(10);
    });
  });

  describe("isSafetyFlagged — PHQ-9 item 9 (index 8), ANY non-zero", () => {
    it("flags when item 9 = 1, 2, or 3 regardless of total", () => {
      for (const answer of [1, 2, 3]) {
        const items = [0, 0, 0, 0, 0, 0, 0, 0, answer];
        expect(isSafetyFlagged("PHQ9", items)).toBe(true);
      }
    });

    it("does not flag when item 9 = 0 even with a high total", () => {
      // Every other item maxed (24), item 9 = 0 → severe band, no flag.
      const items = [3, 3, 3, 3, 3, 3, 3, 3, 0];
      expect(severityBand("PHQ9", scoreTotal(items))).toBe("severe");
      expect(isSafetyFlagged("PHQ9", items)).toBe(false);
    });

    it("never flags GAD-7 (no safety item)", () => {
      expect(isSafetyFlagged("GAD7", [3, 3, 3, 3, 3, 3, 3])).toBe(false);
      expect(INSTRUMENTS.GAD7.safetyItemIndex).toBeNull();
    });
  });
});
