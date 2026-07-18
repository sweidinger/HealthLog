import { describe, it, expect } from "vitest";

import {
  BATCH_COVERAGE_DAYS,
  computeBatchWindow,
  computeLocalBatchWindow,
  deriveBatchChartTypes,
} from "@/lib/dashboard/batch-chart-types";
import {
  resolveDashboardLayout,
  type DashboardLayout,
  type DashboardWidgetConfig,
} from "@/lib/dashboard-layout";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.30.9 — the dashboard batched-series prefetch key crux.
 *
 * `deriveBatchChartTypes` + `computeBatchWindow` are the SINGLE source of the
 * two moving parts of the `chartSeriesBatch(csv, from, to)` cache key. The RSC
 * prefetch (server) and the dashboard client both call them over the SAME
 * snapshot payload / profile window; if they ever disagree the dehydrated
 * slice is dead weight and the client refetches. These tests pin the ordered
 * type derivation, the resting-HR-vs-pulse pick, the profile-tz window, and
 * the byte-identical key both sides build.
 */

/** Build a resolved-shaped layout with exactly the given widget visibility. */
function layoutOf(visible: Record<string, boolean>): DashboardLayout {
  const widgets: DashboardWidgetConfig[] = Object.entries(visible).map(
    ([id, v], i) =>
      ({
        id,
        visible: v,
        order: i,
      }) as DashboardWidgetConfig,
  );
  return { version: 1, widgets };
}

const ALL_VISIBLE = {
  weight: true,
  bp: true,
  pulse: true,
  bodyFat: true,
  steps: true,
};

describe("deriveBatchChartTypes", () => {
  it("emits every visible type with data in insertion order", () => {
    const types = deriveBatchChartTypes(layoutOf(ALL_VISIBLE), {
      WEIGHT: { count: 5 },
      BLOOD_PRESSURE_SYS: { count: 3 },
      BLOOD_PRESSURE_DIA: { count: 3 },
      PULSE: { count: 9 },
      BODY_FAT: { count: 2 },
      ACTIVITY_STEPS: { count: 30 },
    });
    expect(types).toEqual([
      "WEIGHT",
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
      "PULSE",
      "BODY_FAT",
      "ACTIVITY_STEPS",
    ]);
  });

  it("prefers RESTING_HEART_RATE over PULSE when resting rows exist", () => {
    const types = deriveBatchChartTypes(layoutOf({ pulse: true }), {
      PULSE: { count: 40 },
      RESTING_HEART_RATE: { count: 12 },
    });
    expect(types).toEqual(["RESTING_HEART_RATE"]);
  });

  it("falls back to PULSE when only raw pulse rows exist", () => {
    const types = deriveBatchChartTypes(layoutOf({ pulse: true }), {
      PULSE: { count: 40 },
      RESTING_HEART_RATE: { count: 0 },
    });
    expect(types).toEqual(["PULSE"]);
  });

  it("shows the pulse chart on resting rows even with zero raw pulse", () => {
    const types = deriveBatchChartTypes(layoutOf({ pulse: true }), {
      RESTING_HEART_RATE: { count: 7 },
    });
    expect(types).toEqual(["RESTING_HEART_RATE"]);
  });

  it("emits both BP legs when either sys or dia has data", () => {
    const types = deriveBatchChartTypes(layoutOf({ bp: true }), {
      BLOOD_PRESSURE_SYS: { count: 4 },
      BLOOD_PRESSURE_DIA: { count: 0 },
    });
    expect(types).toEqual(["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]);
  });

  it("excludes a hidden chart even with data (visibility floor)", () => {
    const types = deriveBatchChartTypes(
      layoutOf({ weight: false, steps: true }),
      { WEIGHT: { count: 5 }, ACTIVITY_STEPS: { count: 5 } },
    );
    expect(types).toEqual(["ACTIVITY_STEPS"]);
  });

  it("excludes a visible chart with no data (count floor)", () => {
    const types = deriveBatchChartTypes(layoutOf(ALL_VISIBLE), {
      WEIGHT: { count: 0 },
      BODY_FAT: { count: 1 },
    });
    expect(types).toEqual(["BODY_FAT"]);
  });

  it("returns an empty list when nothing is visible-with-data", () => {
    expect(deriveBatchChartTypes(layoutOf(ALL_VISIBLE), {})).toEqual([]);
    expect(deriveBatchChartTypes(layoutOf(ALL_VISIBLE), undefined)).toEqual([]);
  });

  it("is insensitive to summaries key order (stable insertion order out)", () => {
    const a = deriveBatchChartTypes(layoutOf(ALL_VISIBLE), {
      ACTIVITY_STEPS: { count: 1 },
      WEIGHT: { count: 1 },
      BODY_FAT: { count: 1 },
    });
    expect(a).toEqual(["WEIGHT", "BODY_FAT", "ACTIVITY_STEPS"]);
  });
});

describe("computeBatchWindow", () => {
  it("ends the window at profile-tz end-of-day and spans BATCH_COVERAGE_DAYS", () => {
    const now = new Date("2026-07-15T12:00:00.000Z"); // 08:00 EDT
    const win = computeBatchWindow(now, "America/New_York");
    // 2026-07-15 23:59:59.999 -04:00 === 2026-07-16T03:59:59.999Z
    expect(win.to).toBe("2026-07-16T03:59:59.999Z");
    expect(new Date(win.to).getTime() - new Date(win.from).getTime()).toBe(
      BATCH_COVERAGE_DAYS * 86_400_000,
    );
  });

  it("handles a half-hour-offset zone east of UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z"); // 01:30 next day IST
    const win = computeBatchWindow(now, "Asia/Kolkata");
    // local day 2026-07-16, end 23:59:59.999 +05:30 === 2026-07-16T18:29:59.999Z
    expect(win.to).toBe("2026-07-16T18:29:59.999Z");
  });

  it("computes a plain UTC end-of-day", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const win = computeBatchWindow(now, "UTC");
    expect(win.to).toBe("2026-07-15T23:59:59.999Z");
  });

  it("always includes today (to >= now) regardless of zone", () => {
    const now = new Date("2026-07-15T23:30:00.000Z");
    for (const tz of ["UTC", "America/New_York", "Pacific/Auckland"]) {
      const win = computeBatchWindow(now, tz);
      expect(new Date(win.to).getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
  });

  it("is deterministic for the same now + tz (server prop === client adoption)", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    expect(computeBatchWindow(now, "Europe/Berlin")).toEqual(
      computeBatchWindow(now, "Europe/Berlin"),
    );
  });

  it("falls back safely on an unusable timezone id", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const win = computeBatchWindow(now, "Not/AZone");
    expect(typeof win.to).toBe("string");
    expect(new Date(win.to).getTime() - new Date(win.from).getTime()).toBe(
      BATCH_COVERAGE_DAYS * 86_400_000,
    );
  });
});

describe("computeLocalBatchWindow", () => {
  it("matches the legacy browser-local end-of-day computation", () => {
    const now = new Date("2026-07-15T09:00:00.000Z");
    const win = computeLocalBatchWindow(now);
    const to = new Date(now);
    to.setHours(23, 59, 59, 999);
    const from = new Date(to.getTime() - BATCH_COVERAGE_DAYS * 86_400_000);
    expect(win).toEqual({ from: from.toISOString(), to: to.toISOString() });
  });
});

describe("the batched-series key crux — server key === client key", () => {
  // A fixture snapshot payload: the SAME object the RSC dehydrates and the
  // client hydrates. Server and client each run the shared helpers over it.
  const snapshot = {
    layout: {
      version: 1,
      widgets: [
        { id: "weight", visible: true, order: 0 },
        { id: "bp", visible: true, order: 1 },
        { id: "pulse", visible: true, order: 2 },
        { id: "bodyFat", visible: false, order: 3 },
        { id: "steps", visible: true, order: 4 },
      ],
    },
    tiles: {
      summaries: {
        WEIGHT: { count: 12 },
        BLOOD_PRESSURE_SYS: { count: 6 },
        BLOOD_PRESSURE_DIA: { count: 6 },
        RESTING_HEART_RATE: { count: 4 },
        PULSE: { count: 20 },
        BODY_FAT: { count: 3 },
        ACTIVITY_STEPS: { count: 40 },
      },
    },
  };
  const now = new Date("2026-07-15T12:00:00.000Z");
  const tz = "America/New_York";

  it("derives the identical chartSeriesBatch key on both sides", () => {
    // Server side: resolve the round-tripped snapshot layout + summaries.
    const wire = JSON.parse(JSON.stringify(snapshot));
    const serverTypes = deriveBatchChartTypes(
      resolveDashboardLayout(wire.layout),
      wire.tiles.summaries,
    );
    const serverWindow = computeBatchWindow(now, tz);
    const serverKey = queryKeys.chartSeriesBatch(
      serverTypes.join(","),
      serverWindow.from,
      serverWindow.to,
    );

    // Client side: same helpers over the same (live) snapshot, adopting the
    // server window verbatim as the `batchWindow` prop.
    const clientTypes = deriveBatchChartTypes(
      resolveDashboardLayout(snapshot.layout),
      snapshot.tiles.summaries,
    );
    const clientWindow = serverWindow; // threaded as the RSC prop
    const clientKey = queryKeys.chartSeriesBatch(
      clientTypes.join(","),
      clientWindow.from,
      clientWindow.to,
    );

    expect(serverKey).toEqual(clientKey);
    // Pin the concrete shape too (bodyFat hidden → dropped; resting HR wins).
    expect(serverKey).toEqual([
      "chart-data",
      "series-batch",
      "WEIGHT,BLOOD_PRESSURE_SYS,BLOOD_PRESSURE_DIA,RESTING_HEART_RATE,ACTIVITY_STEPS",
      "2026-06-15T03:59:59.999Z",
      "2026-07-16T03:59:59.999Z",
    ]);
  });
});
