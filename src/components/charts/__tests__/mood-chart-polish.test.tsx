import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * v1.4.18 — MoodChart clean-line revert (gradient + emoji rolled back).
 *
 * Marc rejected B1a's coloured area fill below the chart line and the
 * smiley/emoji glyphs at every data point. The line stroke + Dracula
 * tokens stay; the chart now paints a clean monotone line with simple
 * Recharts dots.
 */

const sampleMoodData = vi.hoisted(() => {
  const out: Array<{ date: string; score: number; samples: number }> = [];
  for (let i = 0; i < 14; i++) {
    const dt = new Date(Date.UTC(2026, 4, 1 + i));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    out.push({
      date: `${yy}-${mm}-${dd}`,
      score: 3 + ((i % 3) - 1) * 0.5,
      samples: 1,
    });
  }
  return out;
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { entries: sampleMoodData, summary: null },
    isLoading: false,
  }),
  useQueryClient: () => ({
    cancelQueries: () => Promise.resolve(),
    getQueryData: () => undefined,
    setQueryData: () => undefined,
    invalidateQueries: () => Promise.resolve(),
  }),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

describe("<MoodChart> v1.4.18 clean-line revert", () => {
  it("does NOT paint a gradient fill under the line", async () => {
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { MoodChart } = await import("../mood-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <MoodChart />
      </I18nProvider>,
    );

    expect(html).not.toContain('data-slot="chart-linear-gradient"');
    expect(html).not.toContain("chart-gradient-mood");
    expect(html).not.toContain("linearGradient");
  });

  it("does NOT render emoji glyphs at data points (source check)", async () => {
    // Marc explicitly rejected smileys, especially in the mood chart.
    // Recharts does not paint <Line> dots during SSR (the dot callback
    // only fires after first client render), so the emoji wouldn't
    // surface in renderToStaticMarkup output anyway. Inspecting the
    // module source guarantees the glyph map and the `<text>` glyph
    // factory are gone — we don't want a regression where someone
    // reintroduces them and SSR tests still pass.
    const moduleUrl = new URL("../mood-chart.tsx", import.meta.url);
    const src = readFileSync(fileURLToPath(moduleUrl), "utf8");

    expect(src).not.toContain("moodEmoji");
    expect(src).not.toContain("mood-emoji-glyph");
    expect(src).not.toMatch(/[\u{1F600}-\u{1F64F}]/u);
  });
});
