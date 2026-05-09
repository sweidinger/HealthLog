import { describe, expect, it } from "vitest";

import {
  buildTourStops,
  currentStop,
  initTourState,
  isTourFinished,
  nextStep,
  prevStep,
  skipTour,
  stepCounter,
} from "../tour-state";

describe("tour-state", () => {
  describe("buildTourStops()", () => {
    it("includes the achievements stop by default (5 stops)", () => {
      const stops = buildTourStops();
      expect(stops.map((s) => s.id)).toEqual([
        "tile-strip",
        "quick-add",
        "insights",
        "integrations",
        "achievements",
      ]);
    });

    it("omits the achievements stop when the flag is off (4 stops)", () => {
      const stops = buildTourStops({ includeAchievements: false });
      expect(stops.map((s) => s.id)).toEqual([
        "tile-strip",
        "quick-add",
        "insights",
        "integrations",
      ]);
    });

    it("every stop carries a non-empty i18n title and body key", () => {
      const stops = buildTourStops();
      for (const s of stops) {
        expect(s.titleKey).toMatch(/^onboarding\.tour\.steps\./);
        expect(s.bodyKey).toMatch(/^onboarding\.tour\.steps\./);
        expect(s.titleKey).not.toBe(s.bodyKey);
      }
    });

    it("every stop declares a stable targetId for the data-tour-id contract", () => {
      const stops = buildTourStops();
      for (const s of stops) {
        // `null` is allowed (centred-screen tooltip without a
        // spotlight cutout) but we currently use real targets for
        // every stop — a regression here would mean the spotlight
        // silently falls back to centre-screen.
        expect(typeof s.targetId === "string" && s.targetId.length > 0).toBe(
          true,
        );
      }
    });
  });

  describe("navigation", () => {
    it("starts at index 0 with outcome null", () => {
      const state = initTourState(buildTourStops());
      expect(state.index).toBe(0);
      expect(state.outcome).toBeNull();
      expect(isTourFinished(state)).toBe(false);
      expect(currentStop(state)?.id).toBe("tile-strip");
    });

    it("nextStep advances through the list", () => {
      let state = initTourState(buildTourStops());
      state = nextStep(state);
      expect(currentStop(state)?.id).toBe("quick-add");
      state = nextStep(state);
      expect(currentStop(state)?.id).toBe("insights");
    });

    it("nextStep on the last step finishes the tour with outcome=completed", () => {
      const stops = buildTourStops();
      let state = initTourState(stops);
      // step through every stop
      for (let i = 0; i < stops.length; i++) {
        state = nextStep(state);
      }
      expect(state.outcome).toBe("completed");
      expect(isTourFinished(state)).toBe(true);
      expect(currentStop(state)).toBeNull();
    });

    it("prevStep is pinned at index 0 (LeftArrow on first step is a no-op)", () => {
      const state = initTourState(buildTourStops());
      const back = prevStep(state);
      expect(back.index).toBe(0);
      expect(back.outcome).toBeNull();
    });

    it("prevStep walks backward when not at the start", () => {
      let state = initTourState(buildTourStops());
      state = nextStep(state);
      state = nextStep(state);
      expect(state.index).toBe(2);
      const back = prevStep(state);
      expect(back.index).toBe(1);
    });

    it("skipTour from any step finishes with outcome=skipped", () => {
      let state = initTourState(buildTourStops());
      state = nextStep(state); // on step 2 of 5
      const skipped = skipTour(state);
      expect(skipped.outcome).toBe("skipped");
      expect(isTourFinished(skipped)).toBe(true);
      expect(currentStop(skipped)).toBeNull();
    });

    it("nextStep / prevStep / skipTour are no-ops once finished", () => {
      let state = initTourState(buildTourStops());
      state = skipTour(state);
      const after = nextStep(prevStep(skipTour(state)));
      expect(after).toEqual(state);
    });
  });

  describe("stepCounter", () => {
    it("reports 1-based current and the total step count", () => {
      const stops = buildTourStops();
      let state = initTourState(stops);
      expect(stepCounter(state)).toEqual({ current: 1, total: stops.length });
      state = nextStep(state);
      expect(stepCounter(state)).toEqual({ current: 2, total: stops.length });
    });

    it("clamps `current` to total when the tour is finished", () => {
      let state = initTourState(buildTourStops({ includeAchievements: false }));
      state = skipTour(state);
      expect(stepCounter(state)).toEqual({ current: 4, total: 4 });
    });
  });
});
