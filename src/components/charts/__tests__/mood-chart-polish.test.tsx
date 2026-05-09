import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.16 B1a — MoodChart Apple-Health-style polish contract.
 *
 * The mood chart picks up the same gradient-fill + animation polish
 * the rest of the dashboard charts get; the differentiator is per-
 * point emoji glyphs (a smiley, frown, etc.) instead of plain dots so
 * the user can scan a week at a glance — Apple's Health app uses the
 * same affordance for "Mindfulness Minutes" and similar mood-adjacent
 * surfaces.
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
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
  }),
}));

describe("<MoodChart> v1.4.16 B1a polish", () => {
  it("emits the gradient defs sibling-SVG block", async () => {
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { MoodChart } = await import("../mood-chart");

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <MoodChart />
      </I18nProvider>,
    );

    expect(html).toContain('data-slot="chart-linear-gradient"');
    expect(html).toContain('id="chart-gradient-mood"');
  });
});
