import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      version: 1,
      widgets: [],
      comparisonBaseline: "lastMonth" as const,
    },
    isLoading: false,
  }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  }),
  useQueryClient: () => ({
    cancelQueries: vi.fn(),
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
}));

import { CompareToggle } from "../compare-toggle";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<CompareToggle>", () => {
  it("renders all three baseline segments", () => {
    const html = render(<CompareToggle />);
    expect(html).toContain('data-slot="compare-toggle-option-none"');
    expect(html).toContain('data-slot="compare-toggle-option-lastMonth"');
    expect(html).toContain('data-slot="compare-toggle-option-lastYear"');
  });

  it("marks the persisted baseline as the active segment", () => {
    const html = render(<CompareToggle />);
    // Mocked layout above persists `lastMonth`; that segment must be
    // the only one carrying aria-pressed=true / data-active="true".
    expect(html).toMatch(
      /data-slot="compare-toggle-option-lastMonth"[^>]*data-active="true"/,
    );
    expect(html).not.toMatch(
      /data-slot="compare-toggle-option-none"[^>]*data-active="true"/,
    );
    expect(html).not.toMatch(
      /data-slot="compare-toggle-option-lastYear"[^>]*data-active="true"/,
    );
  });

  it("uses 44px (min-h-11) tap targets per WCAG 2.5.5", () => {
    const html = render(<CompareToggle />);
    // Every segment carries the min-h-11 utility — the WCAG-compliance
    // floor we promise mobile users.
    const segmentCount = (html.match(/data-slot="compare-toggle-option-/g) ?? [])
      .length;
    const minH11Count = (html.match(/min-h-11/g) ?? []).length;
    expect(segmentCount).toBe(3);
    expect(minH11Count).toBeGreaterThanOrEqual(3);
  });

  it("translates the segment labels (EN)", () => {
    const html = render(<CompareToggle />);
    expect(html).toContain("None");
    expect(html).toContain("Last month");
    expect(html).toContain("Last year");
  });

  it("translates the segment labels (DE)", () => {
    const html = render(<CompareToggle />, "de");
    expect(html).toContain("Aus");
    expect(html).toContain("Vormonat");
    expect(html).toContain("Vorjahr");
  });

  it("attaches role=group with the toggleLabel for screen readers", () => {
    const html = render(<CompareToggle />);
    expect(html).toContain('role="group"');
    expect(html).toMatch(/aria-label="(Compare to|Vergleichen mit)"/);
  });
});
