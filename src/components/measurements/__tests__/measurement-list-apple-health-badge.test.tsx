import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.23 — Apple Health source badge regression guard.
 *
 * Mirrors the BP-badge guard above: any non-MANUAL source must paint a
 * Badge with the localised source label. APPLE_HEALTH gets the
 * Dracula-pink chip; the helper falls back to the SCREAMING_SNAKE
 * value if it's an unknown source so this test would catch a missing
 * `sourceAppleHealth` translation key as a stray `APPLE_HEALTH`
 * substring leaking into the DOM.
 */

const baseMeasurements = [
  {
    id: "m-apple-1",
    type: "WEIGHT",
    value: 81.5,
    unit: "kg",
    source: "APPLE_HEALTH",
    measuredAt: "2026-05-09T08:30:00.000Z",
    notes: null,
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/measurements",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { measurements: baseMeasurements, meta: { total: 1 } },
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "marc", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MeasurementList } from "../measurement-list";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MeasurementList />
    </I18nProvider>,
  );
}

describe("MeasurementList — APPLE_HEALTH badge", () => {
  it("renders the localised Apple Health label, never the raw enum", () => {
    const html = render("en");
    expect(html).toContain("Apple Health");
    expect(html).not.toContain(">APPLE_HEALTH<");
  });

  it("paints the badge with the Dracula-pink utility classes", () => {
    const html = render("en");
    // The chip class composition (`border-dracula-pink/50`,
    // `bg-dracula-pink/15`, `text-dracula-pink`) is what gives the
    // badge its iOS-accent identity. Asserting all three keeps the
    // colour contract from drifting silently.
    expect(html).toMatch(/border-dracula-pink\/50/);
    expect(html).toMatch(/bg-dracula-pink\/15/);
    expect(html).toMatch(/text-dracula-pink/);
  });

  it("renders the localised label in German too", () => {
    const html = render("de");
    expect(html).toContain("Apple Health");
  });

  it("paints the source badge in BOTH the desktop table and the mobile card", () => {
    // v1.4.23 W6 design review HIGH-1: the badge previously rendered
    // only inside the desktop `<Table>` cell. iOS users (the audience
    // that actually consumes Apple Health data) land on the mobile
    // card branch and saw no source indicator at all, risking
    // duplicate hand-entries on top of synced rows. Both branches must
    // carry the badge so the surface is honest at every viewport.
    const html = render("en");
    const matches = html.match(/data-testid="measurement-source-badge"/g);
    expect(matches?.length ?? 0).toBe(2);
  });
});
