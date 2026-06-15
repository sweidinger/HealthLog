import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.17.1 — the lab list's loading affordance.
 *
 * Audit 02-H2/L2: the list used a bespoke centred `<Loader2>` (a different
 * spinner size than the page above it). The fix paints a tile-shaped
 * `Skeleton` stack via the shared primitive so labs / recovery / sleep-quality
 * share one loading dialect. On first synchronous render the query is pending,
 * so the skeleton branch shows.
 */

vi.mock("@/lib/api/api-fetch", () => ({
  // Never resolves within the synchronous SSR render → query stays loading.
  apiGet: () => new Promise(() => {}),
  apiDelete: vi.fn(),
}));

import { LabList } from "../lab-list";

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

describe("<LabList> loading", () => {
  it("paints the shared Skeleton stack while loading", () => {
    const html = render(<LabList />);
    expect(html).toContain('data-slot="lab-list-loading"');
    expect(html).toContain('data-slot="skeleton"');
    // No bespoke spinner anymore.
    expect(html).not.toContain("animate-spin");
  });
});
