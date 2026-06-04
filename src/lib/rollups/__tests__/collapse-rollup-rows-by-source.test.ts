/**
 * v1.11.1 — source-aware rollup collapse.
 *
 * The writer mints one rollup row per (type, day, source). This helper
 * resolves overlapping sources to ONE row per bucket via the user's
 * source-priority ladder, so a day with WHOOP + Apple Watch resting heart
 * rate surfaces the ladder-canonical reading instead of an AVG blend.
 *
 * Default ladders pinned here (from `DEFAULT_SOURCE_PRIORITY`):
 *   restingHeartRate: WHOOP > APPLE_HEALTH > WITHINGS
 *   spo2:             WITHINGS > WHOOP > APPLE_HEALTH > MANUAL
 *   recovery:         WHOOP > COMPUTED
 *   steps:            APPLE_HEALTH > WITHINGS > MANUAL
 */
import { describe, expect, it } from "vitest";

import type { MeasurementSource } from "@/generated/prisma/client";
import { collapseRollupRowsBySource } from "../measurement-read";

interface Row {
  bucketStart: Date;
  source: MeasurementSource;
  count: number;
  mean: number;
  sumValue: number | null;
}

const DAY1 = new Date("2026-06-01T00:00:00.000Z");
const DAY2 = new Date("2026-06-02T00:00:00.000Z");

function row(
  bucketStart: Date,
  source: MeasurementSource,
  mean: number,
  count = 1,
  sumValue: number | null = null,
): Row {
  return { bucketStart, source, count, mean, sumValue };
}

describe("collapseRollupRowsBySource", () => {
  it("picks WHOOP over Apple for resting heart rate (ladder head wins)", () => {
    const out = collapseRollupRowsBySource(
      [
        row(DAY1, "APPLE_HEALTH", 54),
        row(DAY1, "WHOOP", 51),
      ],
      "RESTING_HEART_RATE",
      null,
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("WHOOP");
    expect(out[0].mean).toBe(51);
  });

  it("picks Withings over Apple for SpO₂", () => {
    const out = collapseRollupRowsBySource(
      [
        row(DAY1, "APPLE_HEALTH", 96),
        row(DAY1, "WITHINGS", 98),
      ],
      "OXYGEN_SATURATION",
      null,
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("WITHINGS");
    expect(out[0].mean).toBe(98);
  });

  it("picks native WHOOP over the COMPUTED proxy for RECOVERY_SCORE", () => {
    const out = collapseRollupRowsBySource(
      [
        row(DAY1, "COMPUTED", 62),
        row(DAY1, "WHOOP", 70),
      ],
      "RECOVERY_SCORE",
      null,
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("WHOOP");
  });

  it("collapses cumulative steps to ONE source's sum (never cross-source sum)", () => {
    const out = collapseRollupRowsBySource(
      [
        row(DAY1, "WITHINGS", 3800, 1, 3800),
        row(DAY1, "APPLE_HEALTH", 4000, 1, 4000),
      ],
      "ACTIVITY_STEPS",
      null,
    );
    expect(out).toHaveLength(1);
    // steps ladder = APPLE_HEALTH first → canonical source's sum only, NOT 7800.
    expect(out[0].source).toBe("APPLE_HEALTH");
    expect(out[0].sumValue).toBe(4000);
  });

  it("preserves multi-day series, collapsing each day independently", () => {
    const out = collapseRollupRowsBySource(
      [
        row(DAY1, "APPLE_HEALTH", 54),
        row(DAY1, "WHOOP", 51),
        row(DAY2, "WHOOP", 49),
      ],
      "RESTING_HEART_RATE",
      null,
    );
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.bucketStart.getTime())).toEqual([
      DAY1.getTime(),
      DAY2.getTime(),
    ]);
    expect(out.every((r) => r.source === "WHOOP")).toBe(true);
  });

  it("leaves a single-source day unchanged (fast path)", () => {
    const input = [row(DAY1, "WITHINGS", 72)];
    const out = collapseRollupRowsBySource(input, "WEIGHT", null);
    expect(out).toBe(input);
  });

  it("honours a custom source-priority override", () => {
    // User pins Apple above WHOOP for resting heart rate.
    const custom = {
      restingHeartRate: ["APPLE_HEALTH", "WHOOP", "WITHINGS"],
    };
    const out = collapseRollupRowsBySource(
      [
        row(DAY1, "WHOOP", 51),
        row(DAY1, "APPLE_HEALTH", 54),
      ],
      "RESTING_HEART_RATE",
      custom,
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("APPLE_HEALTH");
  });

  it("falls back to the alphabetically-smallest source when none is on the ladder", () => {
    // Neither IMPORT nor MANUAL is on the restingHeartRate ladder; keep one
    // row deterministically by source name, matching the live-SQL paths'
    // `ORDER BY … source` tiebreak (live/rollup parity).
    const out = collapseRollupRowsBySource(
      [
        row(DAY1, "MANUAL", 58, 5),
        row(DAY1, "IMPORT", 60, 2),
      ],
      "RESTING_HEART_RATE",
      null,
    );
    expect(out).toHaveLength(1);
    // "IMPORT" < "MANUAL" alphabetically.
    expect(out[0].source).toBe("IMPORT");
  });

  it("returns empty input untouched", () => {
    expect(collapseRollupRowsBySource([], "WEIGHT", null)).toEqual([]);
  });
});
