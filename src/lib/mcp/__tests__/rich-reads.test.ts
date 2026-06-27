import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Engine mocks hoisted before importing the module under test. ---
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/ai/coach/tools/correlations-read", () => ({
  readCoachCorrelations: vi.fn(),
}));
vi.mock("@/lib/insights/derived/coach-read", () => ({
  buildCoachReadStrip: vi.fn(),
}));
// Keep the real `aggregateWmyBuckets` (pure linear composition); stub only the
// DB-backed reader so the rich reads compute over a synthetic bucket sequence.
vi.mock("@/lib/rollups/measurement-read-wmy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rollups/measurement-read-wmy")>();
  return { ...actual, readBestGranularityRollups: vi.fn() };
});

import {
  getCorrelation,
  compareMetric,
  getMetricBaseline,
  detectChangepoints,
  resolveRichMetric,
} from "../rich-reads";
import { readCoachCorrelations } from "@/lib/ai/coach/tools/correlations-read";
import { buildCoachReadStrip } from "@/lib/insights/derived/coach-read";
import { readBestGranularityRollups } from "@/lib/rollups/measurement-read-wmy";

const USER = "user-1";

/** Build a rollup bucket row with just the fields the rich reads consume. */
function row(bucketStart: string, mean: number) {
  return {
    bucketStart: new Date(bucketStart),
    count: 1,
    mean,
    sd: null,
    slope: null,
    r2: null,
    sumValue: null,
    minValue: mean,
    maxValue: mean,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ── metric resolution ────────────────────────────────────────────────
describe("resolveRichMetric", () => {
  it("resolves a friendly alias to the registry type + unit + band", () => {
    const m = resolveRichMetric("resting_hr");
    expect(m?.measurementType).toBe("RESTING_HEART_RATE");
    expect(m?.unit).toBe("bpm");
    expect(m?.band).toEqual({ low: 50, high: 100 });
  });

  it("resolves the headline supplement metrics (weight has no universal band)", () => {
    const weight = resolveRichMetric("weight");
    expect(weight?.measurementType).toBe("WEIGHT");
    expect(weight?.unit).toBe("kg");
    expect(weight?.band).toBeNull();
    expect(resolveRichMetric("pulse")?.band).toEqual({ low: 60, high: 100 });
  });

  it("matches on display name", () => {
    expect(resolveRichMetric("heart-rate variability")?.measurementType).toBe(
      "HEART_RATE_VARIABILITY",
    );
  });

  it("returns null for an unknown metric (never invents a series)", () => {
    expect(resolveRichMetric("bananas")).toBeNull();
    expect(resolveRichMetric("")).toBeNull();
  });
});

// ── 1. get_correlation ───────────────────────────────────────────────
describe("get_correlation", () => {
  const drivers = [
    {
      behaviour: "sleep duration",
      outcome: "resting heart rate",
      direction: "lower" as const,
      lagDays: 1,
      n: 60,
      r: -0.42,
      note: "Nights with more sleep tend to precede a lower next-day resting heart rate. Descriptive, not causal.",
    },
    {
      behaviour: "steps",
      outcome: "weight",
      direction: "lower" as const,
      lagDays: 1,
      n: 40,
      r: -0.2,
      note: "Descriptive only.",
    },
  ];

  it("returns the matched FDR-controlled pair with a descriptive (non-causal) note", async () => {
    vi.mocked(readCoachCorrelations).mockResolvedValue({
      present: true,
      drivers,
      pairsTested: 24,
      windowDays: 180,
    });
    const res = await getCorrelation(USER, {
      metricA: "sleep",
      metricB: "resting heart rate",
    });
    expect(res.present).toBe(true);
    expect(res.pair?.behaviour).toBe("sleep duration");
    expect(res.pair?.outcome).toBe("resting heart rate");
    expect(res.pair?.r).toBe(-0.42);
    expect(res.association).toBe("descriptive");
    expect(res.windowDays).toBe(180);
  });

  it("honest-null when the pair has no surviving association", async () => {
    vi.mocked(readCoachCorrelations).mockResolvedValue({
      present: true,
      drivers,
      pairsTested: 24,
      windowDays: 180,
    });
    const res = await getCorrelation(USER, {
      metricA: "glucose",
      metricB: "hrv",
    });
    expect(res.present).toBe(false);
    expect(res.reason).toBe("no_significant_pattern_for_pair");
    expect(res.pair).toBeUndefined();
  });

  it("honest-null when the engine surfaces nothing (sparse data)", async () => {
    vi.mocked(readCoachCorrelations).mockResolvedValue({
      present: false,
      reason: "no_significant_pattern",
    });
    const res = await getCorrelation(USER, {
      metricA: "sleep",
      metricB: "weight",
    });
    expect(res.present).toBe(false);
    expect(res.reason).toBe("no_significant_pattern");
  });
});

// ── 2. compare_metric ────────────────────────────────────────────────
describe("compare_metric", () => {
  it("compares two metrics over the same window and computes a delta when units match", async () => {
    vi.mocked(readBestGranularityRollups)
      .mockResolvedValueOnce({
        granularity: "DAY",
        rows: [row("2026-06-01", 60), row("2026-06-02", 62)],
      })
      .mockResolvedValueOnce({
        granularity: "DAY",
        rows: [row("2026-06-01", 70), row("2026-06-02", 72)],
      });
    const res = await compareMetric(USER, {
      metric: "resting_hr",
      metricB: "pulse",
      window: "last30days",
    });
    expect(res.present).toBe(true);
    expect(res.mode).toBe("metric_vs_metric");
    expect(res.a?.mean).toBe(61);
    expect(res.b?.mean).toBe(71);
    // Both bpm → delta computed.
    expect(res.delta?.mean).toBe(10);
    expect(res.a?.unit).toBe("bpm");
  });

  it("compares one metric across two trailing windows", async () => {
    vi.mocked(readBestGranularityRollups)
      .mockResolvedValueOnce({
        granularity: "DAY",
        rows: [row("2026-06-01", 80), row("2026-06-02", 80)],
      })
      .mockResolvedValueOnce({
        granularity: "WEEK",
        rows: [row("2026-04-01", 82), row("2026-04-08", 84)],
      });
    const res = await compareMetric(USER, {
      metric: "weight",
      window: "last30days",
      windowB: "last90days",
    });
    expect(res.present).toBe(true);
    expect(res.mode).toBe("window_vs_window");
    expect(res.delta?.mean).toBe(3); // 83 - 80
  });

  it("asks for a second metric or window when neither is given", async () => {
    const res = await compareMetric(USER, { metric: "weight" });
    expect(res.present).toBe(false);
    expect(res.reason).toBe("specify_metricB_or_windowB");
  });

  it("honest-null on unknown metric", async () => {
    const res = await compareMetric(USER, {
      metric: "bananas",
      metricB: "weight",
    });
    expect(res.present).toBe(false);
    expect(res.reason).toBe("unknown_metric");
  });

  it("present:false when a side has no data", async () => {
    vi.mocked(readBestGranularityRollups)
      .mockResolvedValueOnce({
        granularity: "DAY",
        rows: [row("2026-06-01", 80)],
      })
      .mockResolvedValueOnce(null);
    const res = await compareMetric(USER, {
      metric: "weight",
      window: "last30days",
      windowB: "last90days",
    });
    expect(res.present).toBe(false);
    expect(res.reason).toBe("no_data");
  });
});

// ── 3. get_metric_baseline ───────────────────────────────────────────
describe("get_metric_baseline", () => {
  it("returns the personal band + today's placement + reference band", async () => {
    vi.mocked(buildCoachReadStrip).mockResolvedValue({
      baseline: {
        low: 55,
        high: 65,
        latest: 70,
        placement: "above",
        sampleDays: 30,
      },
      learning: false,
      driver: {
        note: "Descriptive only.",
        behaviour: "sleep duration",
        outcome: "resting heart rate",
      },
    });
    const res = await getMetricBaseline(USER, { metric: "resting_hr" });
    expect(res.present).toBe(true);
    expect(res.baseline).toEqual({ low: 55, high: 65, sampleDays: 30 });
    expect(res.latest).toBe(70);
    expect(res.placement).toBe("above");
    expect(res.unit).toBe("bpm");
    expect(res.referenceBand).toEqual({ low: 50, high: 100 });
  });

  it("honest-null below the learning floor (never a fabricated range)", async () => {
    vi.mocked(buildCoachReadStrip).mockResolvedValue({
      baseline: null,
      learning: true,
      driver: null,
    });
    const res = await getMetricBaseline(USER, { metric: "weight" });
    expect(res.present).toBe(false);
    expect(res.reason).toBe("insufficient_history");
    // The personal band is absent — no invented numbers.
    expect(res.baseline).toBeUndefined();
  });

  it("honest-null on unknown metric", async () => {
    const res = await getMetricBaseline(USER, { metric: "bananas" });
    expect(res.present).toBe(false);
    expect(res.reason).toBe("unknown_metric");
  });
});

// ── 4. detect_changepoints ───────────────────────────────────────────
describe("detect_changepoints", () => {
  it("detects a clear level shift over the rollup buckets", async () => {
    // Twelve buckets: ~80 for six, then a clean jump to ~90 for six.
    const rows = [
      row("2026-03-01", 80),
      row("2026-03-02", 81),
      row("2026-03-03", 79),
      row("2026-03-04", 80),
      row("2026-03-05", 81),
      row("2026-03-06", 80),
      row("2026-03-07", 90),
      row("2026-03-08", 91),
      row("2026-03-09", 89),
      row("2026-03-10", 90),
      row("2026-03-11", 91),
      row("2026-03-12", 90),
    ];
    vi.mocked(readBestGranularityRollups).mockResolvedValue({
      granularity: "DAY",
      rows,
    });
    const res = await detectChangepoints(USER, {
      metric: "weight",
      window: "last90days",
    });
    expect(res.present).toBe(true);
    expect(res.changepoints?.length).toBeGreaterThanOrEqual(1);
    const cp = res.changepoints![0];
    expect(cp.direction).toBe("increase");
    expect(cp.at).toBe(new Date("2026-03-07").toISOString());
    expect(res.granularity).toBe("DAY");
  });

  it("honest-null on a flat (noise-only) series", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row(`2026-03-${String(i + 1).padStart(2, "0")}`, 80 + (i % 2)),
    );
    vi.mocked(readBestGranularityRollups).mockResolvedValue({
      granularity: "DAY",
      rows,
    });
    const res = await detectChangepoints(USER, { metric: "weight" });
    expect(res.present).toBe(false);
    expect(res.reason).toBe("no_changepoint");
    expect(res.bucketsAnalysed).toBe(12);
  });

  it("honest-null when too few buckets exist", async () => {
    vi.mocked(readBestGranularityRollups).mockResolvedValue({
      granularity: "DAY",
      rows: [row("2026-03-01", 80), row("2026-03-02", 81)],
    });
    const res = await detectChangepoints(USER, { metric: "weight" });
    expect(res.present).toBe(false);
    expect(res.reason).toBe("insufficient_data");
  });

  it("honest-null on unknown metric", async () => {
    const res = await detectChangepoints(USER, { metric: "bananas" });
    expect(res.present).toBe(false);
    expect(res.reason).toBe("unknown_metric");
  });
});

// ── grounding posture ────────────────────────────────────────────────
describe("grounding / no fabrication", () => {
  it("no rich read returns a verdict / diagnosis / advice field", async () => {
    vi.mocked(readCoachCorrelations).mockResolvedValue({ present: false });
    vi.mocked(buildCoachReadStrip).mockResolvedValue({
      baseline: null,
      learning: true,
      driver: null,
    });
    vi.mocked(readBestGranularityRollups).mockResolvedValue(null);

    const results = [
      await getCorrelation(USER, { metricA: "sleep", metricB: "weight" }),
      await compareMetric(USER, { metric: "weight", windowB: "last90days" }),
      await getMetricBaseline(USER, { metric: "weight" }),
      await detectChangepoints(USER, { metric: "weight" }),
    ];
    for (const res of results) {
      const keys = Object.keys(res);
      expect(keys).not.toContain("verdict");
      expect(keys).not.toContain("diagnosis");
      expect(keys).not.toContain("advice");
    }
  });
});
