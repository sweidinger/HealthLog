/**
 * v1.16.0 — dashboard first-load choreography.
 *
 * Two complaints from the maintainer's first-load walk-through:
 *
 *   1. The tile strip painted EMPTY dark cards while the primary query
 *      was in flight — no inner structure previewing the final tile.
 *   2. The chart row popped in one chart at a time: every chart owns
 *      its own query, `/api/mood/analytics` is a single cheap read, so
 *      the mood chart reliably painted first and the measurement
 *      charts trickled in afterwards.
 *
 * The fix: structured `<TrendCardSkeleton>` silhouettes for every tile
 * slot, plus a shared reveal gate (`useDashboardChartReveal` /
 * `<DashboardChartCell>`) that holds every gated chart on its
 * layout-stable skeleton until every chart's data settled — or the 2 s
 * fallback fires so one slow widget cannot block the row.
 *
 * Project convention is SSR-only tests (vitest `node` environment, no
 * DOM test runner): the gate logic is pinned through the pure
 * `resolveChartRevealState` resolver, the markup through
 * `renderToStaticMarkup`, and the page wiring through textual pins.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CHART_REVEAL_TIMEOUT_MS,
  DashboardChartCell,
  resolveChartRevealState,
} from "@/components/dashboard/chart-reveal";
import { TrendCardSkeleton } from "@/components/charts/trend-card-skeleton";
import { I18nProvider } from "@/lib/i18n/context";

const PAGE_PATH = join(process.cwd(), "src/app/page.tsx");

describe("resolveChartRevealState", () => {
  it("stays hidden while the gate is not armed (no visible charts yet)", () => {
    expect(
      resolveChartRevealState({
        expectedIds: [],
        readyIds: new Set(),
        timedOut: false,
      }),
    ).toBe(false);
    // Even a stale timeout cannot reveal an empty row.
    expect(
      resolveChartRevealState({
        expectedIds: [],
        readyIds: new Set(),
        timedOut: true,
      }),
    ).toBe(false);
  });

  it("holds the skeletons while any gated chart is still loading", () => {
    expect(
      resolveChartRevealState({
        expectedIds: ["weight-chart", "mood-chart"],
        readyIds: new Set(["mood-chart"]),
        timedOut: false,
      }),
    ).toBe(false);
  });

  it("reveals once every gated chart reported ready (the Promise.all moment)", () => {
    expect(
      resolveChartRevealState({
        expectedIds: ["weight-chart", "mood-chart"],
        readyIds: new Set(["weight-chart", "mood-chart"]),
        timedOut: false,
      }),
    ).toBe(true);
  });

  it("reveals on timeout so a slow widget cannot block the row", () => {
    expect(
      resolveChartRevealState({
        expectedIds: ["weight-chart", "mood-chart"],
        readyIds: new Set(),
        timedOut: true,
      }),
    ).toBe(true);
  });

  it("pins the 2 s fallback budget", () => {
    expect(CHART_REVEAL_TIMEOUT_MS).toBe(2_000);
  });
});

describe("DashboardChartCell", () => {
  const render = (revealed: boolean) =>
    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <DashboardChartCell revealed={revealed}>
          <div data-slot="probe-chart">chart body</div>
        </DashboardChartCell>
      </I18nProvider>,
    );

  it("hidden state: keeps the chart mounted but invisible under a skeleton overlay", () => {
    const html = render(false);
    expect(html).toContain('data-revealed="false"');
    // Chart stays mounted (its query must fire) but is layout-only.
    expect(html).toContain('data-slot="probe-chart"');
    expect(html).toContain("invisible");
    expect(html).toContain('aria-hidden="true"');
    // Layout-stable skeleton overlays the same box.
    expect(html).toContain('data-slot="chart-skeleton"');
    expect(html).toContain("absolute inset-0");
  });

  it("revealed state: drops the skeleton and fades the content in (motion-safe)", () => {
    const html = render(true);
    expect(html).toContain('data-revealed="true"');
    expect(html).not.toContain('data-slot="chart-skeleton"');
    expect(html).not.toContain("invisible");
    expect(html).toContain("motion-safe:animate-in");
    expect(html).toContain("motion-safe:fade-in");
  });
});

describe("TrendCardSkeleton", () => {
  it("renders a structured silhouette, not an empty card", () => {
    const html = renderToStaticMarkup(<TrendCardSkeleton />);
    expect(html).toContain('data-slot="trend-card-skeleton"');
    expect(html).toContain('aria-hidden="true"');
    // Structured: heading row + headline value + sub-row blocks.
    const skeletonBlocks = html.match(/data-slot="skeleton"/g) ?? [];
    expect(skeletonBlocks.length).toBeGreaterThanOrEqual(5);
    // Same outer chrome + min-height floor as the real TrendCard slot.
    expect(html).toContain("rounded-xl");
    expect(html).toContain("min-h-[8rem]");
    // Reduced motion honoured via the Skeleton primitive.
    expect(html).toContain("motion-reduce:animate-none");
  });
});

describe("dashboard chart-reveal wiring (page.tsx)", () => {
  const src = readFileSync(PAGE_PATH, "utf8");

  it("derives the gated id list from the chart visibility gates", () => {
    expect(src).toMatch(
      /const\s+revealChartIds:\s*string\[\]\s*=\s*\[\];/,
    );
    expect(src).toMatch(
      /useDashboardChartReveal\(revealChartIds\)/,
    );
  });

  it("every data-backed chart reports through onDataReady", () => {
    for (const id of [
      "weight-chart",
      "bmi-chart",
      "bp-chart",
      "pulse-chart",
      "bodyFat-chart",
      "mood-chart",
      "sleep-chart",
      "steps-chart",
      "medications",
    ]) {
      expect(src).toContain(`onDataReady={() => markChartReady("${id}")}`);
    }
  });

  it("gated entries render inside DashboardChartCell", () => {
    expect(src).toMatch(
      /entry\.revealGated\s*\?[\s\S]*?<DashboardChartCell revealed=\{chartsRevealed\}>/,
    );
  });

  it("self-skeletoning cards (achievements / workouts) stay outside the gate", () => {
    // Their entries never set `revealGated`, so the ungated branch
    // renders them directly.
    const achievements = src.match(
      /charts\.push\(\{\s*id:\s*"achievements"[\s\S]*?\}\);/,
    );
    const workouts = src.match(
      /charts\.push\(\{\s*id:\s*"recentWorkouts"[\s\S]*?\}\);/,
    );
    expect(achievements?.[0]).not.toContain("revealGated");
    expect(workouts?.[0]).not.toContain("revealGated");
  });
});
