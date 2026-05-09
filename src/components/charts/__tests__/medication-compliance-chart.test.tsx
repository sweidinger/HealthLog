import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MedicationComplianceChart,
  aggregateMedicationCompliance,
} from "../medication-compliance-chart";

/**
 * Stubs — the dashboard chart wrappers all need TanStack Query +
 * useAuth shims to render in SSR. We don't care about live data; we
 * only assert that the wrapper paints its title and "no data" empty
 * state when the query resolves to an empty array, and that the
 * aggregation helper produces the correct rates.
 */

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, isLoading: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("aggregateMedicationCompliance()", () => {
  it("computes rate as taken/scheduled rounded to nearest integer", () => {
    const out = aggregateMedicationCompliance([
      { date: "2026-05-01", scheduled: 4, taken: 4 }, // 100 %
      { date: "2026-05-02", scheduled: 4, taken: 3 }, // 75 %
      { date: "2026-05-03", scheduled: 4, taken: 2 }, // 50 %
      { date: "2026-05-04", scheduled: 4, taken: 0 }, // 0 %
    ]);
    expect(out.map((p) => p.rate)).toEqual([100, 75, 50, 0]);
  });

  it("skips days where no doses were scheduled (rate undefined)", () => {
    const out = aggregateMedicationCompliance([
      { date: "2026-05-01", scheduled: 0, taken: 0 }, // skipped
      { date: "2026-05-02", scheduled: 2, taken: 2 }, // 100 %
      { date: "2026-05-03", scheduled: 0, taken: 0 }, // skipped
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rate).toBe(100);
  });

  it("clamps over-100 % rates (e.g. extra ad-hoc takes) to 100", () => {
    const out = aggregateMedicationCompliance([
      { date: "2026-05-01", scheduled: 2, taken: 5 },
    ]);
    expect(out[0].rate).toBe(100);
  });

  it("sorts by date ascending regardless of input order", () => {
    const out = aggregateMedicationCompliance([
      { date: "2026-05-03", scheduled: 1, taken: 1 },
      { date: "2026-05-01", scheduled: 1, taken: 1 },
      { date: "2026-05-02", scheduled: 1, taken: 1 },
    ]);
    expect(out.map((p) => p.timestamp)).toEqual(
      [...out.map((p) => p.timestamp)].sort((a, b) => a - b),
    );
  });

  it("emits an empty array when all input days have no scheduled doses", () => {
    const out = aggregateMedicationCompliance([
      { date: "2026-05-01", scheduled: 0, taken: 0 },
    ]);
    expect(out).toEqual([]);
  });
});

describe("<MedicationComplianceChart>", () => {
  it("renders the section title and the empty-state message when data is empty", () => {
    const html = render(<MedicationComplianceChart />);
    // Title — fallback to dashboard.medications when no override prop.
    expect(html).toContain("Medications");
    // Empty state surfaces the i18n no-data string.
    expect(html).toContain("No data");
    // The wrapper data-slot is present so e2e/visual-verify can target it.
    expect(html).toContain('data-slot="medication-compliance-chart"');
  });

  it("respects an explicit title override", () => {
    const html = render(<MedicationComplianceChart title="Adherence" />);
    expect(html).toContain("Adherence");
  });
});
