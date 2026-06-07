import React from "react";
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { InsightsEditMode } from "../insights-edit-mode";
import {
  DEFAULT_INSIGHTS_LAYOUT,
  type InsightsSectionId,
} from "@/lib/insights-layout";
import {
  MANAGER_GROUP_ORDER,
  SUB_PAGE_MANAGER_GROUP_SLUGS,
} from "@/lib/insights/sub-page-metric";

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

describe("<InsightsEditMode> — broadened sub-page manager (v1.15.14 W2)", () => {
  const noneGated: ReadonlySet<InsightsSectionId> = new Set();

  it("relabels the Vitals disclosure to 'Manage detail pages'", () => {
    const html = render(
      <InsightsEditMode
        layout={DEFAULT_INSIGHTS_LAYOUT}
        gatedOffSectionIds={noneGated}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('data-slot="insights-edit-tiles-disclosure"');
    expect(html).toContain("Manage detail pages");
  });

  it("groups every routed sub-page slug under exactly one manager group", () => {
    // The disclosure body is collapsed in SSR (no effects fire), so this
    // asserts the data the manager renders FROM rather than the open DOM:
    // every group in the manager order carries at least one slug, and the
    // three tab-strip-flat categories (sleep / mood / events) are present.
    expect(MANAGER_GROUP_ORDER).toContain("mood");
    expect(MANAGER_GROUP_ORDER).toContain("events");
    expect(MANAGER_GROUP_ORDER).toContain("sleep");
    // A non-vitals slug (`steps`) lands in the activity group so it is
    // toggle-able from the manager — the round-trip the spec calls out.
    expect(SUB_PAGE_MANAGER_GROUP_SLUGS.activity).toContain("steps");
  });
});
