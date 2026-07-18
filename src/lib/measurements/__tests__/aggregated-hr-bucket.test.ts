/**
 * v1.30.7 (iOS #34) — aggregated 10-minute heart-rate wire-contract helpers.
 *
 * Covers the externalId minting, the well-formedness guard, and the bucket-start
 * parser that the batch ingest route + the intraday reader use to route the
 * go-forward 10-min-average PULSE bucket through the existing `stats:` overwrite
 * path. Supersedes the retired v1.19.0 hourly shape.
 */
import { describe, expect, it } from "vitest";

import {
  heartRateBucketExternalId,
  isAggregatedBucketExternalId,
  parseAggregatedBucketStart,
  targetsAggregatedBucket,
} from "@/lib/measurements/apple-health-mapping";

describe("heartRateBucketExternalId", () => {
  it("floors to the 10-minute UTC bucket and mints the canonical stats id", () => {
    const id = heartRateBucketExternalId(new Date("2026-07-18T14:37:42.913Z"));
    expect(id).toBe(
      "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T14:30:00.000Z",
    );
  });

  it("is stable: two instants in the same 10-min window map to one id", () => {
    const a = heartRateBucketExternalId(new Date("2026-07-18T14:30:00Z"));
    const b = heartRateBucketExternalId(new Date("2026-07-18T14:39:59Z"));
    expect(a).toBe(b);
  });

  it("keeps adjacent 10-min windows distinct", () => {
    const a = heartRateBucketExternalId(new Date("2026-07-18T14:29:59Z"));
    const b = heartRateBucketExternalId(new Date("2026-07-18T14:30:00Z"));
    expect(a).not.toBe(b);
  });

  it("round-trips through the well-formedness guard and the parser", () => {
    const id = heartRateBucketExternalId(new Date("2026-01-02T03:04:05Z"));
    expect(isAggregatedBucketExternalId(id)).toBe(true);
    expect(parseAggregatedBucketStart(id)?.toISOString()).toBe(
      "2026-01-02T03:00:00.000Z",
    );
  });
});

describe("isAggregatedBucketExternalId", () => {
  it.each([
    "2026-07-18T14:00:00.000Z",
    "2026-07-18T14:10:00.000Z",
    "2026-07-18T14:20:00.000Z",
    "2026-07-18T14:30:00.000Z",
    "2026-07-18T14:40:00.000Z",
    "2026-07-18T14:50:00.000Z",
  ])("accepts a well-formed 10-min bucket ending %s", (suffix) => {
    expect(
      isAggregatedBucketExternalId(
        `stats:HKQuantityTypeIdentifierHeartRate:${suffix}`,
      ),
    ).toBe(true);
  });

  it.each([
    // off-grid minute (not a multiple of 10)
    "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T14:05:00.000Z",
    "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T14:35:00.000Z",
    // missing millis
    "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T14:30:00Z",
    // date-only (the per-day cumulative shape)
    "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18",
    // the retention fold's local-hour shape (no Z) — a folded row, not a bucket
    "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T14",
    // no trailing Z
    "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T14:30:00.000",
    // garbage suffix
    "stats:HKQuantityTypeIdentifierHeartRate:not-a-date",
    // matches the shape but fails Date parse (impossible month)
    "stats:HKQuantityTypeIdentifierHeartRate:2026-13-01T14:30:00.000Z",
  ])("rejects malformed suffix %s", (id) => {
    expect(isAggregatedBucketExternalId(id)).toBe(false);
  });

  it.each([
    // a non-allowlisted HK identifier's per-day stats row
    "stats:HKQuantityTypeIdentifierStepCount:2026-07-18",
    // a per-sample uuid externalId
    "B3A1C0DE-0000-4000-8000-000000000000",
    null,
    undefined,
  ])("returns false for a non-bucket externalId %s", (id) => {
    expect(isAggregatedBucketExternalId(id as string | null)).toBe(false);
  });

  it.each([
    // v1.30.8 — these PARSE via V8's silent rollover but are NOT canonical, so
    // they'd key a row the canonical (toISOString) client never emits → an
    // un-mergeable duplicate + wrong-day placement. Must be rejected.
    "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T24:00:00.000Z", // → 07-19T00
    "stats:HKQuantityTypeIdentifierHeartRate:2026-04-31T14:30:00.000Z", // → 05-01
    "stats:HKQuantityTypeIdentifierHeartRate:2026-02-29T14:30:00.000Z", // non-leap → 03-01
    "stats:HKQuantityTypeIdentifierHeartRate:2026-12-31T24:00:00.000Z", // → 2027-01-01
  ])("rejects a non-canonical rollover instant %s", (id) => {
    expect(isAggregatedBucketExternalId(id)).toBe(false);
    expect(parseAggregatedBucketStart(id)).toBeNull();
  });
});

describe("targetsAggregatedBucket", () => {
  it("is true for any allowlisted-HK bucket prefix, valid or malformed", () => {
    expect(
      targetsAggregatedBucket(
        "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T14:30:00.000Z",
      ),
    ).toBe(true);
    expect(
      targetsAggregatedBucket(
        "stats:HKQuantityTypeIdentifierHeartRate:not-a-date",
      ),
    ).toBe(true);
  });

  it("is false for a non-allowlisted stats row, per-sample uuids, and null", () => {
    expect(
      targetsAggregatedBucket(
        "stats:HKQuantityTypeIdentifierStepCount:2026-07-18",
      ),
    ).toBe(false);
    expect(targetsAggregatedBucket("some-uuid")).toBe(false);
    expect(targetsAggregatedBucket(null)).toBe(false);
  });
});

describe("parseAggregatedBucketStart", () => {
  it("returns the canonical UTC bucket-start instant of a well-formed id", () => {
    expect(
      parseAggregatedBucketStart(
        "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T14:30:00.000Z",
      )?.toISOString(),
    ).toBe("2026-07-18T14:30:00.000Z");
  });

  it.each([
    "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T14:05:00.000Z",
    "stats:HKQuantityTypeIdentifierHeartRate:2026-07-18T14",
    "stats:HKQuantityTypeIdentifierStepCount:2026-07-18",
    "some-uuid",
    null,
  ])("returns null for a non-bucket / malformed id %s", (id) => {
    expect(parseAggregatedBucketStart(id as string | null)).toBeNull();
  });
});
