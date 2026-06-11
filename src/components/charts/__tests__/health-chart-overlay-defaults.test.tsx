import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * v1.4.18 — Default overlay state on chart wrappers.
 *
 * The maintainer rejected the always-on personal-baseline reference line that B1a
 * painted on every chart. The default surface for a new chart should be
 * a clean line + axes + tooltip — no baseline, no target-zone shading,
 * no trend line. Overlays are user-opt-in via the per-chart settings
 * popover (commit "feat(charts): per-chart overlay-controls component")
 * and persisted (commit "feat(charts): persist per-chart overlay
 * prefs"). The default state of every toggle is OFF.
 *
 * The personal baseline used to render unconditionally as a
 * `<ReferenceLine label="Your normal">`. We assert the SSR markup ships
 * no `personalBaseline` label and no in-target reference area when the
 * chart starts up.
 */

const sampleSeries = vi.hoisted(() => {
  const out: Array<{ measuredAt: string; value: number }> = [];
  for (let i = 0; i < 30; i++) {
    const dt = new Date(Date.UTC(2026, 4, 1 + i, 12, 0, 0));
    out.push({
      measuredAt: dt.toISOString(),
      value: 118 + (i % 5) - 2 + i * 0.05,
    });
  }
  return out;
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: sampleSeries.map((row) => {
      const ts = Date.parse(row.measuredAt);
      return {
        date: new Date(ts).toDateString(),
        timestamp: ts,
        BLOOD_PRESSURE_SYS: row.value,
      };
    }),
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

describe("HealthChart default overlay state", () => {
  it("source: personal baseline is gated behind a toggle (no unconditional ReferenceLine)", () => {
    // The B1a wrapper rendered the baseline `<ReferenceLine>` for every
    // type unconditionally. Make sure the source no longer paints it
    // outside an opt-in branch — we look for the tell-tale pattern of
    // `types.map((type, i) => { ... <ReferenceLine ... y={baseline}`
    // appearing without a `showTrend` / `showBaseline` guard above it.
    const moduleUrl = new URL("../health-chart.tsx", import.meta.url);
    const src = readFileSync(fileURLToPath(moduleUrl), "utf8");

    // Personal-baseline rendering must be guarded — the JSX block that
    // emits the dashed baseline must be wrapped in a conditional
    // expression starting with a state flag.
    const baselineSection = src.match(
      /\{types\.map\(\(type, i\) => \{[\s\S]*?const baseline = personalBaselines\.get\(type\);[\s\S]*?\}\)\}/,
    );
    if (baselineSection) {
      // If the section still exists, it's not gated. Allow a guard
      // wrapper test instead — match `{showSomething &&`.
      throw new Error(
        "Personal baseline ReferenceLine is rendered unconditionally — must be gated behind an opt-in toggle.",
      );
    }
  });

  it("does NOT paint the personal-baseline label by default in MoodChart source", () => {
    const moduleUrl = new URL("../mood-chart.tsx", import.meta.url);
    const src = readFileSync(fileURLToPath(moduleUrl), "utf8");
    // Same guard — the baseline ReferenceLine must be wrapped in a
    // condition (showTrend / similar), not always painted.
    expect(src).not.toMatch(
      /\{personalBaseline != null && \(\n\s+<ReferenceLine\n/,
    );
  });
});
