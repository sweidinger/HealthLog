import { describe, it, expect } from "vitest";

import {
  computeZones,
  parseWhoopZoneDurations,
  hrMaxFromAge,
} from "@/lib/workouts/zones";
import type { HrSeriesPoint } from "@/lib/workouts/hr-series";

function pt(tSec: number, mean: number): HrSeriesPoint {
  return { tSec, mean, min: mean, max: mean };
}

describe("hrMaxFromAge", () => {
  it("applies Tanaka and rounds", () => {
    expect(hrMaxFromAge(40)).toBe(180); // 208 − 0.7·40
    expect(hrMaxFromAge(null)).toBeNull();
  });
});

describe("computeZones — %HRmax (tanaka)", () => {
  const hrMax = 180; // age 40 → Z1 90-108, Z3 126-144, Z5 162+

  it("folds series buckets into %HRmax zones by mean HR", () => {
    const series = [
      pt(0, 100), // 55 % → Z1
      pt(10, 135), // 75 % → Z3
      pt(20, 140), // 78 % → Z3
      pt(30, 170), // 94 % → Z5
    ];
    const zones = computeZones({
      hrMax,
      series,
      bucketSec: 10,
      whoopZoneDurations: null,
    })!;
    expect(zones.model).toBe("tanaka");
    expect(zones.hrMax).toBe(180);
    const byZone = Object.fromEntries(
      zones.zones.map((z) => [z.zone, z.seconds]),
    );
    expect(byZone[1]).toBe(10);
    expect(byZone[3]).toBe(20);
    expect(byZone[5]).toBe(10);
    expect(byZone[2]).toBe(0);
    // Bounds carry bpm edges; the top zone is open-ended.
    const z5 = zones.zones.find((z) => z.zone === 5)!;
    expect(z5.lowBpm).toBe(162);
    expect(z5.highBpm).toBeNull();
  });

  it("excludes below-Z1 (rest) time and returns null when all rest", () => {
    const series = [pt(0, 80), pt(10, 85)]; // < 50 % HRmax
    expect(
      computeZones({ hrMax, series, bucketSec: 10, whoopZoneDurations: null }),
    ).toBeNull();
  });

  it("returns null without profile age", () => {
    expect(
      computeZones({
        hrMax: null,
        series: [pt(0, 140)],
        bucketSec: 10,
        whoopZoneDurations: null,
      }),
    ).toBeNull();
  });
});

describe("computeZones — WHOOP wins", () => {
  it("uses device-reported durations over the computed series", () => {
    const zones = computeZones({
      hrMax: 180,
      series: [pt(0, 140)],
      bucketSec: 10,
      whoopZoneDurations: [60, 120, 180, 240, 300],
    })!;
    expect(zones.model).toBe("whoop");
    const seconds = zones.zones.map((z) => z.seconds);
    expect(seconds).toEqual([60, 120, 180, 240, 300]);
    // Bounds still resolve from HRmax when age is known.
    expect(zones.zones[0].lowBpm).toBe(90);
  });

  it("carries null bounds when HRmax is unknown but WHOOP zones exist", () => {
    const zones = computeZones({
      hrMax: null,
      series: [],
      bucketSec: 10,
      whoopZoneDurations: [10, 20, 30, 40, 50],
    })!;
    expect(zones.model).toBe("whoop");
    expect(zones.hrMax).toBeNull();
    expect(zones.zones[0].lowBpm).toBeNull();
  });
});

describe("parseWhoopZoneDurations", () => {
  it("maps zone_one..zone_five milliseconds to Z1..Z5 seconds", () => {
    const parsed = parseWhoopZoneDurations({
      zoneDurations: {
        zone_zero_milli: 900000,
        zone_one_milli: 60000,
        zone_two_milli: 120000,
        zone_three_milli: 0,
        zone_four_milli: 0,
        zone_five_milli: 30000,
      },
    });
    expect(parsed).toEqual([60, 120, 0, 0, 30]);
  });

  it("returns null for absent, malformed, or all-zero durations", () => {
    expect(parseWhoopZoneDurations(null)).toBeNull();
    expect(parseWhoopZoneDurations({})).toBeNull();
    expect(parseWhoopZoneDurations({ zoneDurations: "nope" })).toBeNull();
    expect(
      parseWhoopZoneDurations({ zoneDurations: { zone_one_milli: 0 } }),
    ).toBeNull();
  });
});
