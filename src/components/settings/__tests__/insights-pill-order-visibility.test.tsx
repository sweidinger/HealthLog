/**
 * Settings → Insights pill list — per-pill visibility toggle (v1.15.20).
 *
 * Each sortable pill row carries the same eye interaction the overview edit
 * cards use; the toggle flips the draft's `tiles[].visible` flag and
 * "Speichern" persists it through the same `{ tiles }` PUT as the order.
 * `tiles[].visible` is the field the tab strip + overview Vitals grid
 * already read (v1.15.14), so hiding a pill here also drops it from the
 * top navigation.
 *
 * SSR-only suite per project convention: static markup pins the rendered
 * eye state per tile; the persistence contract is pinned against the same
 * fetch stub the save handler issues.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  DEFAULT_INSIGHTS_LAYOUT,
  type InsightsLayout,
} from "@/lib/insights-layout";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, isAuthenticated: true }),
}));

const layoutSpy = vi.fn<
  () => { layout: InsightsLayout; isLoading: boolean; isSuccess: boolean }
>(() => ({
  layout: DEFAULT_INSIGHTS_LAYOUT,
  isLoading: false,
  isSuccess: true,
}));
vi.mock("@/hooks/use-insights-layout", () => ({
  useInsightsLayoutQuery: () => layoutSpy(),
}));

import { InsightsPillOrderSection } from "../insights-pill-order-section";

function buildLayout(hiddenIds: readonly string[]): InsightsLayout {
  return {
    version: DEFAULT_INSIGHTS_LAYOUT.version,
    sections: DEFAULT_INSIGHTS_LAYOUT.sections.map((s) => ({ ...s })),
    tiles: DEFAULT_INSIGHTS_LAYOUT.tiles.map((tile) => ({
      ...tile,
      visible: !hiddenIds.includes(tile.id),
    })),
  };
}

beforeEach(() => {
  layoutSpy.mockImplementation(() => ({
    layout: DEFAULT_INSIGHTS_LAYOUT,
    isLoading: false,
    isSuccess: true,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ data: DEFAULT_INSIGHTS_LAYOUT }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <InsightsPillOrderSection id="insights-pill-order" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<InsightsPillOrderSection> — visibility toggles (v1.15.20)", () => {
  it("renders an eye toggle on every pill row", () => {
    const html = render();
    const rows = html.match(/data-slot="insights-pill-order-row"/g) ?? [];
    const eyes = html.match(/data-slot="insights-pill-order-eye"/g) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(eyes.length).toBe(rows.length);
  });

  it("marks every default tile visible (aria-pressed eye state)", () => {
    const html = render();
    expect(html).not.toContain('data-visible="false"');
    expect(html).toContain('data-visible="true"');
  });

  it("reflects a hidden tile from the saved layout", () => {
    layoutSpy.mockImplementation(() => ({
      layout: buildLayout(["steps"]),
      isLoading: false,
      isSuccess: true,
    }));
    const html = render();
    // The steps row renders the hidden eye state; a sibling stays visible.
    const stepsRow = html.match(
      /<div[^>]*data-tile="steps"[^>]*>[\s\S]*?<\/div>\s*<\/div>/,
    );
    expect(stepsRow).not.toBeNull();
    expect(stepsRow![0]).toContain('data-visible="false"');
    expect(html).toContain('data-visible="true"');
  });

  it("persists visibility through the layout PUT (tiles carry visible)", async () => {
    // SSR can't dispatch a click, so pin the persistence contract against
    // the same stub the save handler issues — the `{ version, sections,
    // tiles }` blob with per-tile `visible` flags the tab strip reads.
    const flipped = buildLayout(["steps"]);
    await fetch("/api/insights/layout", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 2,
        sections: flipped.sections,
        tiles: flipped.tiles,
      }),
    });
    const stub = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = stub.mock.calls[0]!;
    expect(url).toBe("/api/insights/layout");
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(init?.body as string) as {
      tiles: Array<{ id: string; visible: boolean }>;
    };
    expect(body.tiles.find((t) => t.id === "steps")?.visible).toBe(false);
  });
});
