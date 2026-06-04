/**
 * v1.11.4 (iOS #2) — unit coverage for the MANUAL↔APPLE_HEALTH
 * same-reading merge predicate. The route integration test exercises the
 * end-to-end ingest path; this suite pins the pure matching rule:
 *   - cross-source same reading → match
 *   - same-source / server-source pair → no match (no over-merge)
 *   - different value or out-of-tolerance timestamp → no match
 */
import { describe, expect, it } from "vitest";

import {
  MEASURED_AT_TOLERANCE_MS,
  isMergeableSource,
  isSameReadingAcrossSource,
  measuredAtMatch,
  oppositeMergeSource,
  valuesMatch,
  type MergeCandidate,
} from "@/lib/measurements/cross-source-merge";
import type { MeasurementType } from "@/generated/prisma/client";

const T0 = new Date("2026-06-04T07:30:00.000Z");

function candidate(over: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    type: "WEIGHT" as MeasurementType,
    source: "MANUAL",
    value: 81.4,
    measuredAt: T0,
    ...over,
  };
}

function incoming(
  over: Partial<{
    type: MeasurementType;
    source: string;
    value: number;
    measuredAt: Date;
  }> = {},
) {
  return {
    type: "WEIGHT" as MeasurementType,
    source: "APPLE_HEALTH",
    value: 81.4,
    measuredAt: T0,
    ...over,
  };
}

describe("isMergeableSource", () => {
  it("accepts only the two client-facing mirror sources", () => {
    expect(isMergeableSource("MANUAL")).toBe(true);
    expect(isMergeableSource("APPLE_HEALTH")).toBe(true);
    expect(isMergeableSource("WITHINGS")).toBe(false);
    expect(isMergeableSource("IMPORT")).toBe(false);
    expect(isMergeableSource("COMPUTED")).toBe(false);
    expect(isMergeableSource("WHOOP")).toBe(false);
  });
});

describe("oppositeMergeSource", () => {
  it("flips MANUAL ↔ APPLE_HEALTH", () => {
    expect(oppositeMergeSource("MANUAL")).toBe("APPLE_HEALTH");
    expect(oppositeMergeSource("APPLE_HEALTH")).toBe("MANUAL");
  });
});

describe("valuesMatch", () => {
  it("matches identical and sub-epsilon values", () => {
    expect(valuesMatch(81.4, 81.4)).toBe(true);
    expect(valuesMatch(81.4, 81.4 + 1e-12)).toBe(true);
    expect(valuesMatch(0.97, 0.97)).toBe(true);
  });

  it("rejects genuinely different values", () => {
    expect(valuesMatch(81.4, 81.5)).toBe(false);
    expect(valuesMatch(120, 121)).toBe(false);
  });
});

describe("measuredAtMatch", () => {
  it("matches inside the ±tolerance window", () => {
    expect(measuredAtMatch(T0, T0)).toBe(true);
    expect(
      measuredAtMatch(T0, new Date(T0.getTime() + MEASURED_AT_TOLERANCE_MS)),
    ).toBe(true);
    expect(
      measuredAtMatch(T0, new Date(T0.getTime() - MEASURED_AT_TOLERANCE_MS)),
    ).toBe(true);
  });

  it("rejects timestamps beyond the tolerance window", () => {
    expect(
      measuredAtMatch(
        T0,
        new Date(T0.getTime() + MEASURED_AT_TOLERANCE_MS + 1),
      ),
    ).toBe(false);
    // A whole minute apart — two distinct readings, never the mirror pair.
    expect(measuredAtMatch(T0, new Date(T0.getTime() + 60_000))).toBe(false);
  });
});

describe("isSameReadingAcrossSource", () => {
  it("matches a MANUAL candidate against an incoming APPLE_HEALTH mirror", () => {
    expect(isSameReadingAcrossSource(incoming(), candidate())).toBe(true);
  });

  it("matches an APPLE_HEALTH candidate against an incoming MANUAL mirror", () => {
    expect(
      isSameReadingAcrossSource(
        incoming({ source: "MANUAL" }),
        candidate({ source: "APPLE_HEALTH" }),
      ),
    ).toBe(true);
  });

  it("matches within the timestamp tolerance", () => {
    expect(
      isSameReadingAcrossSource(
        incoming({ measuredAt: new Date(T0.getTime() + 1_500) }),
        candidate(),
      ),
    ).toBe(true);
  });

  it("does NOT match a same-source pair (no over-merge)", () => {
    // Two APPLE_HEALTH readings — keep the existing per-source contract.
    expect(
      isSameReadingAcrossSource(
        incoming({ source: "APPLE_HEALTH" }),
        candidate({ source: "APPLE_HEALTH" }),
      ),
    ).toBe(false);
    // Two MANUAL readings.
    expect(
      isSameReadingAcrossSource(
        incoming({ source: "MANUAL" }),
        candidate({ source: "MANUAL" }),
      ),
    ).toBe(false);
  });

  it("does NOT match when a server-owned source is involved", () => {
    expect(
      isSameReadingAcrossSource(
        incoming({ source: "APPLE_HEALTH" }),
        candidate({ source: "WITHINGS" }),
      ),
    ).toBe(false);
    // Incoming WITHINGS could never reach this route, but the predicate
    // must still refuse it.
    expect(
      isSameReadingAcrossSource(
        incoming({ source: "WITHINGS" }),
        candidate({ source: "APPLE_HEALTH" }),
      ),
    ).toBe(false);
  });

  it("does NOT match a different measurement type", () => {
    expect(
      isSameReadingAcrossSource(
        incoming({ type: "PULSE" as MeasurementType }),
        candidate({ type: "WEIGHT" as MeasurementType }),
      ),
    ).toBe(false);
  });

  it("does NOT match a different value (two real readings, same minute)", () => {
    expect(
      isSameReadingAcrossSource(incoming({ value: 81.4 }), candidate({ value: 82.0 })),
    ).toBe(false);
  });

  it("does NOT match a timestamp beyond the tolerance window", () => {
    expect(
      isSameReadingAcrossSource(
        incoming({ measuredAt: new Date(T0.getTime() + 60_000) }),
        candidate(),
      ),
    ).toBe(false);
  });
});
