/**
 * v1.15.0 — cycle-tracking feature gate resolver.
 */
import { describe, it, expect } from "vitest";

import { isCycleEnabled, CYCLE_DISABLED_ERROR_CODE } from "../gate";

describe("isCycleEnabled", () => {
  it("derives from gender when the toggle is null", () => {
    expect(isCycleEnabled("FEMALE", { cycleTrackingEnabled: null })).toBe(true);
    expect(isCycleEnabled("MALE", { cycleTrackingEnabled: null })).toBe(false);
    expect(isCycleEnabled(null, { cycleTrackingEnabled: null })).toBe(false);
  });

  it("derives from gender when no profile row exists", () => {
    expect(isCycleEnabled("FEMALE", null)).toBe(true);
    expect(isCycleEnabled("MALE", undefined)).toBe(false);
    expect(isCycleEnabled(null, null)).toBe(false);
  });

  it("an explicit true opts a non-FEMALE account in", () => {
    expect(isCycleEnabled("MALE", { cycleTrackingEnabled: true })).toBe(true);
    expect(isCycleEnabled(null, { cycleTrackingEnabled: true })).toBe(true);
  });

  it("an explicit false opts a FEMALE account out", () => {
    expect(isCycleEnabled("FEMALE", { cycleTrackingEnabled: false })).toBe(
      false,
    );
  });

  it("gates on UPPERCASE FEMALE only (server enum spelling)", () => {
    // Lowercase / other spellings never enable by derivation.
    expect(isCycleEnabled("female", { cycleTrackingEnabled: null })).toBe(false);
    expect(isCycleEnabled("OTHER", { cycleTrackingEnabled: null })).toBe(false);
  });

  it("exports the wire errorCode the iOS retry classifier branches on", () => {
    expect(CYCLE_DISABLED_ERROR_CODE).toBe("cycle.disabled");
  });
});
