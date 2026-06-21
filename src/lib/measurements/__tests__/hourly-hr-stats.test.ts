/**
 * v1.19.0 (iOS #34) — hourly heart-rate wire-contract helpers.
 *
 * Covers the externalId minting + well-formedness guard that the batch
 * ingest route uses to route the go-forward hourly-average PULSE bucket
 * through the existing `stats:` overwrite path.
 */
import { describe, expect, it } from "vitest";

import {
  hourlyHeartRateStatsExternalId,
  isHourlyHeartRateStatsExternalId,
  targetsHourlyHeartRateBucket,
} from "@/lib/measurements/apple-health-mapping";

describe("hourlyHeartRateStatsExternalId", () => {
  it("floors to the UTC hour and mints the canonical stats externalId", () => {
    const id = hourlyHeartRateStatsExternalId(
      new Date("2026-06-21T14:37:42.913Z"),
    );
    expect(id).toBe(
      "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T14:00:00.000Z",
    );
  });

  it("is stable: two instants in the same UTC hour map to one id", () => {
    const a = hourlyHeartRateStatsExternalId(new Date("2026-06-21T14:00:00Z"));
    const b = hourlyHeartRateStatsExternalId(new Date("2026-06-21T14:59:59Z"));
    expect(a).toBe(b);
  });

  it("round-trips through the well-formedness guard", () => {
    const id = hourlyHeartRateStatsExternalId(new Date("2026-01-02T03:04:05Z"));
    expect(isHourlyHeartRateStatsExternalId(id)).toBe(true);
  });
});

describe("isHourlyHeartRateStatsExternalId", () => {
  it("accepts a zeroed ISO-hour HR bucket", () => {
    expect(
      isHourlyHeartRateStatsExternalId(
        "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T14:00:00.000Z",
      ),
    ).toBe(true);
  });

  it.each([
    // non-zero minutes
    "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T14:30:00.000Z",
    // missing millis
    "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T14:00:00Z",
    // date-only (the per-day cumulative shape, not hourly)
    "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21",
    // no trailing Z
    "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T14:00:00.000",
    // garbage suffix
    "stats:HKQuantityTypeIdentifierHeartRate:not-a-date",
    // impossible month still matches the regex shape but fails Date parse
    "stats:HKQuantityTypeIdentifierHeartRate:2026-13-01T14:00:00.000Z",
  ])("rejects malformed suffix %s", (id) => {
    expect(isHourlyHeartRateStatsExternalId(id)).toBe(false);
  });

  it.each([
    // a different HK identifier's per-day stats row
    "stats:HKQuantityTypeIdentifierStepCount:2026-06-21",
    // a per-sample uuid externalId
    "B3A1C0DE-0000-4000-8000-000000000000",
    null,
    undefined,
  ])("returns false for non-HR-bucket externalId %s", (id) => {
    expect(isHourlyHeartRateStatsExternalId(id as string | null)).toBe(false);
  });
});

describe("targetsHourlyHeartRateBucket", () => {
  it("is true for any HR-bucket prefix, valid or malformed", () => {
    expect(
      targetsHourlyHeartRateBucket(
        "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T14:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      targetsHourlyHeartRateBucket(
        "stats:HKQuantityTypeIdentifierHeartRate:not-a-date",
      ),
    ).toBe(true);
  });

  it("is false for per-day cumulative stats and per-sample uuids", () => {
    expect(
      targetsHourlyHeartRateBucket(
        "stats:HKQuantityTypeIdentifierStepCount:2026-06-21",
      ),
    ).toBe(false);
    expect(targetsHourlyHeartRateBucket("some-uuid")).toBe(false);
    expect(targetsHourlyHeartRateBucket(null)).toBe(false);
  });
});
