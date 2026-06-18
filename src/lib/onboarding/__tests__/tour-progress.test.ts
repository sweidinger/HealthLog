import { describe, it, expect } from "vitest";

import {
  parseTourProgress,
  tourProgressSchema,
  type TourProgress,
} from "@/lib/onboarding/tour-progress";

const valid: TourProgress = {
  lastStopId: "labs",
  completedStopIds: ["dashboardOverview", "quickAdd"],
  status: "in_progress",
  updatedAt: "2026-06-18T10:00:00.000Z",
};

describe("tour-progress", () => {
  it("parses a well-formed progress object", () => {
    expect(parseTourProgress(valid)).toEqual(valid);
  });

  it("treats null / undefined as not-started", () => {
    expect(parseTourProgress(null)).toBeNull();
    expect(parseTourProgress(undefined)).toBeNull();
  });

  it("degrades a corrupt blob to null rather than throwing", () => {
    expect(parseTourProgress({ status: "bogus" })).toBeNull();
    expect(parseTourProgress({ lastStopId: 42 })).toBeNull();
    expect(parseTourProgress("not-an-object")).toBeNull();
  });

  it("defaults completedStopIds to an empty array", () => {
    const parsed = tourProgressSchema.parse({
      lastStopId: null,
      status: "skipped",
      updatedAt: "2026-06-18T10:00:00.000Z",
    });
    expect(parsed.completedStopIds).toEqual([]);
  });

  it("accepts a null lastStopId (centred/wrap stop or fresh start)", () => {
    expect(parseTourProgress({ ...valid, lastStopId: null })).not.toBeNull();
  });

  it("rejects an over-long completedStopIds array", () => {
    const tooMany = Array.from({ length: 65 }, (_, i) => `s${i}`);
    expect(
      parseTourProgress({ ...valid, completedStopIds: tooMany }),
    ).toBeNull();
  });
});
