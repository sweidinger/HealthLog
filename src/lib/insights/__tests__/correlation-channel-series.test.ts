import { describe, it, expect } from "vitest";
import type { SleepStage } from "@/generated/prisma/client";
import {
  buildMeasurementDailySeries,
  toDailyMeans,
  type MeasurementSeriesRow,
} from "@/lib/insights/correlation-channel-series";

/** Build a raw measurement row for `buildMeasurementDailySeries`. */
function row(
  iso: string,
  value: number,
  source: MeasurementSeriesRow["source"] = "APPLE_HEALTH",
  sleepStage: SleepStage | null = null,
  deviceType: string | null = null,
): MeasurementSeriesRow {
  return { at: new Date(iso), value, source, deviceType, sleepStage };
}

describe("buildMeasurementDailySeries — grain consistency (v1.29.6)", () => {
  it("sums (not averages) a cumulative type across mixed per-sample-chunk and drained daily-total rows", () => {
    const rows: MeasurementSeriesRow[] = [
      // 2026-06-04: two ~mid-morning / afternoon per-sample chunks — the
      // "not-yet-drained" shape.
      row("2026-06-04T08:00:00.000Z", 350),
      row("2026-06-04T14:00:00.000Z", 300),
      // 2026-06-05: a single drained `stats:` daily total.
      row("2026-06-05T12:00:00.000Z", 8400),
    ];

    const points = buildMeasurementDailySeries(
      "ACTIVITY_STEPS",
      rows,
      "UTC",
      null,
    );

    expect(points).toEqual([
      { day: "2026-06-04", value: 650 },
      { day: "2026-06-05", value: 8400 },
    ]);

    // The old `toDailyMeans` reduction would have produced meaningless
    // blended figures — pin that the two grains disagree, so a future
    // regression that reverts to `toDailyMeans` for this type is caught.
    const meanPoints = toDailyMeans(
      rows.map((r) => ({ value: r.value, at: r.at })),
      "UTC",
    );
    expect(meanPoints.find((p) => p.day === "2026-06-04")?.value).toBe(325); // mean of 350/300
    expect(meanPoints.find((p) => p.day === "2026-06-05")?.value).toBe(8400); // single row, coincides
  });

  it("collapses overlapping sources to the ladder-canonical reading before summing a cumulative type", () => {
    const rows: MeasurementSeriesRow[] = [
      row("2026-06-04T08:00:00.000Z", 9000, "APPLE_HEALTH"),
      row("2026-06-04T08:05:00.000Z", 8800, "WITHINGS"),
    ];

    const points = buildMeasurementDailySeries(
      "ACTIVITY_STEPS",
      rows,
      "UTC",
      null,
    );

    // Default `steps` ladder ranks APPLE_HEALTH above WITHINGS — the
    // Withings row must drop out of the sum entirely, not add on top.
    expect(points).toEqual([{ day: "2026-06-04", value: 9000 }]);
  });

  it("sums a night's per-stage segments into one total instead of averaging them", () => {
    // One night: CORE 240 + DEEP 90 + REM 80 = 410 minutes asleep.
    // `measuredAt` is the END of each segment; the reconstructor derives
    // the start from `measuredAt - value minutes` (mirrors sleep-night.test.ts).
    const rows: MeasurementSeriesRow[] = [
      row("2026-06-04T04:00:00.000Z", 240, "APPLE_HEALTH", "CORE"),
      row("2026-06-04T05:30:00.000Z", 90, "APPLE_HEALTH", "DEEP"),
      row("2026-06-04T07:00:00.000Z", 80, "APPLE_HEALTH", "REM"),
    ];

    const points = buildMeasurementDailySeries(
      "SLEEP_DURATION",
      rows,
      "UTC",
      null,
    );

    expect(points).toHaveLength(1);
    // The pre-fix `toDailyMeans` reduction would have averaged the three
    // segment durations (240 + 90 + 80) / 3 ≈ 137 — a number with no
    // clinical meaning. The correct grain is the night's TOTAL.
    expect(points[0].value).toBe(410);
    expect(points[0].value).not.toBeCloseTo((240 + 90 + 80) / 3, 0);
  });

  it("collapses an overlapping-source night (WHOOP + Apple Health) to one canonical total, never double-counted", () => {
    // Same night, two writers: WHOOP (wins the default `sleep` ladder)
    // reports a shorter granular breakdown; Apple Health separately
    // reports its own (different) total for the same night. Without the
    // writer-dedup a naive per-row collapse could blend or double both.
    const rows: MeasurementSeriesRow[] = [
      row("2026-06-04T04:00:00.000Z", 200, "WHOOP", "CORE"),
      row("2026-06-04T05:00:00.000Z", 60, "WHOOP", "DEEP"),
      row("2026-06-04T04:30:00.000Z", 300, "APPLE_HEALTH", "CORE"),
    ];

    const points = buildMeasurementDailySeries(
      "SLEEP_DURATION",
      rows,
      "UTC",
      null,
    );

    expect(points).toHaveLength(1);
    // WHOOP wins the default `sleep` ladder — the night's total is the
    // WHOOP-only sum (260), not a blend with Apple Health's 300 and not
    // the two summed together (560).
    expect(points[0].value).toBe(260);
  });

  it("keeps the MEAN grain for spot metrics (unchanged behaviour)", () => {
    const rows: MeasurementSeriesRow[] = [
      row("2026-06-04T08:00:00.000Z", 60),
      row("2026-06-04T20:00:00.000Z", 64),
    ];

    const points = buildMeasurementDailySeries("PULSE", rows, "UTC", null);

    expect(points).toEqual([{ day: "2026-06-04", value: 62 }]);
  });
});
