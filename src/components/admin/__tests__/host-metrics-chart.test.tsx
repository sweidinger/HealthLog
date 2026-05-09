import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { HostMetricsChart, buildChartRows } from "../host-metrics-chart";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({
    data: undefined,
    isLoading: true,
    isError: false,
    refetch: vi.fn(),
  })),
}));

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("buildChartRows", () => {
  it("returns an empty result when no samples are passed", () => {
    const result = buildChartRows([]);
    expect(result.rows).toEqual([]);
    expect(result.peakDiskBps).toBe(0);
    expect(result.hasDiskData).toBe(false);
  });

  it("computes diskBusyPercent relative to the window's peak", () => {
    const samples = [
      {
        capturedAt: "2026-05-09T10:00:00Z",
        loadAvg1: 0.4,
        memUsedPercent: 40,
        diskReadBps: 100,
        diskWriteBps: 100,
      },
      {
        capturedAt: "2026-05-09T10:01:00Z",
        loadAvg1: 0.5,
        memUsedPercent: 45,
        diskReadBps: 600,
        diskWriteBps: 400,
      },
      {
        capturedAt: "2026-05-09T10:02:00Z",
        loadAvg1: 0.6,
        memUsedPercent: 50,
        diskReadBps: 50,
        diskWriteBps: 50,
      },
    ];

    const result = buildChartRows(samples);
    expect(result.peakDiskBps).toBe(1_000); // 600 + 400
    expect(result.hasDiskData).toBe(true);
    // First sample: 200 / 1000 = 20%
    expect(result.rows[0].diskBusyPercent).toBe(20);
    // Second sample: 1000 / 1000 = 100%
    expect(result.rows[1].diskBusyPercent).toBe(100);
    // Third sample: 100 / 1000 = 10%
    expect(result.rows[2].diskBusyPercent).toBe(10);
    // Load + mem are passed through unchanged.
    expect(result.rows[1].loadAvg1).toBe(0.5);
    expect(result.rows[1].memUsedPercent).toBe(45);
  });

  it("returns null diskBusyPercent for samples without disk counters", () => {
    const samples = [
      {
        capturedAt: "2026-05-09T10:00:00Z",
        loadAvg1: 0.1,
        memUsedPercent: 30,
        diskReadBps: null,
        diskWriteBps: null,
      },
      {
        capturedAt: "2026-05-09T10:01:00Z",
        loadAvg1: 0.2,
        memUsedPercent: 31,
        diskReadBps: null,
        diskWriteBps: null,
      },
    ];

    const result = buildChartRows(samples);
    expect(result.hasDiskData).toBe(false);
    expect(result.peakDiskBps).toBe(0);
    expect(result.rows[0].diskBusyPercent).toBeNull();
    expect(result.rows[1].diskBusyPercent).toBeNull();
  });

  it("mixes null + valued disk samples and only flags hasDiskData when present", () => {
    const samples = [
      {
        capturedAt: "2026-05-09T10:00:00Z",
        loadAvg1: 0.1,
        memUsedPercent: 30,
        diskReadBps: null,
        diskWriteBps: null,
      },
      {
        capturedAt: "2026-05-09T10:01:00Z",
        loadAvg1: 0.2,
        memUsedPercent: 31,
        diskReadBps: 500,
        diskWriteBps: 500,
      },
    ];

    const result = buildChartRows(samples);
    expect(result.hasDiskData).toBe(true);
    expect(result.peakDiskBps).toBe(1_000);
    expect(result.rows[0].diskBusyPercent).toBeNull();
    expect(result.rows[1].diskBusyPercent).toBe(100);
  });
});

describe("<HostMetricsChart>", () => {
  it("renders the loading skeleton with the section heading", () => {
    const html = render(<HostMetricsChart />);
    expect(html).toContain("admin-host-metrics-heading");
    expect(html).toContain("Host load");
    expect(html).toContain("animate-pulse");
  });
});
