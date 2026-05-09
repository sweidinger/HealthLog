import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.16 B1a — Medication compliance chart polish contract.
 *
 * The medication chart already has 7-day-trend + target lines from A6;
 * this commit adds the rest of the v1.4.16 visual leap so the surface
 * matches BP/weight/pulse/mood: gradient fill, animated first render,
 * rich tooltip primitive.
 */

const sampleData = vi.hoisted(() =>
  Array.from({ length: 14 }, (_, i) => ({
    date: `2026-05-${String(i + 1).padStart(2, "0")}`,
    scheduled: 4,
    taken: 3 + (i % 2),
  })),
);

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: sampleData, isLoading: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, isLoading: false }),
}));

describe("<MedicationComplianceChart> v1.4.16 B1a polish", () => {
  it("emits the gradient defs sibling-SVG block", async () => {
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { MedicationComplianceChart } = await import(
      "../medication-compliance-chart"
    );

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <MedicationComplianceChart />
      </I18nProvider>,
    );

    expect(html).toContain('data-slot="chart-linear-gradient"');
    expect(html).toContain('id="chart-gradient-medication"');
  });
});
