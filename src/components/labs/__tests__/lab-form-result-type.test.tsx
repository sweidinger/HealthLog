import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.18.9 — the lab form's numeric ↔ qualitative result-type toggle.
 *
 * SSR-only smoke render (the suite's `renderToStaticMarkup` dialect): the form
 * mounts in its default NUMERIC mode, so the test asserts the toggle is present
 * (both mode labels render) and the numeric value field is shown by default.
 * Interactive mode-switching is exercised by the validation + serialise unit
 * tests, which pin the numeric-XOR-qualitative contract this toggle feeds.
 */

vi.mock("@/lib/api/api-fetch", () => ({
  // Catalog never resolves within the synchronous SSR render.
  apiGet: () => new Promise(() => {}),
  apiPost: vi.fn(),
}));

import { LabForm } from "../lab-form";

function render(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<LabForm> result-type toggle", () => {
  it("renders both numeric and qualitative mode options", () => {
    const html = render(<LabForm />);
    expect(html).toContain("Numeric");
    expect(html).toContain("Qualitative");
    expect(html).toContain("Result type");
  });

  it("shows the numeric value field by default (numeric mode)", () => {
    const html = render(<LabForm />);
    // The numeric value input carries the id `lab-value`; the qualitative input
    // (`lab-valueText`) is hidden until the user switches modes.
    expect(html).toContain('id="lab-value"');
    expect(html).not.toContain('id="lab-valueText"');
  });
});
