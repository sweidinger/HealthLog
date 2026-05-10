import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.18 — Medication compliance chart clean-line revert.
 *
 * Rolls back B1a's gradient fill. The animation, target / threshold
 * lines, rich tooltip, and 7-day trend chip stay (those weren't
 * rejected).
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

describe("<MedicationComplianceChart> v1.4.18 clean-line revert", () => {
  it("does NOT paint a gradient fill under the line", async () => {
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { MedicationComplianceChart } = await import(
      "../medication-compliance-chart"
    );

    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <MedicationComplianceChart />
      </I18nProvider>,
    );

    expect(html).not.toContain("data-slot=\"chart-linear-gradient\"");
    expect(html).not.toContain("chart-gradient-medication");
    expect(html).not.toContain("linearGradient");
  });
});
