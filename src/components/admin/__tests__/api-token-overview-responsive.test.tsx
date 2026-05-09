import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.15 phase A2 — `/admin/api-tokens` table responsive guard.
 *
 * The token table previously rendered six full-width columns at every
 * breakpoint. On Pixel-5-class viewports (360 CSS px) the row exceeded
 * the card and forced the document itself to scroll horizontally. The
 * fix hides three lower-priority columns (user, last-used, created)
 * until `sm:`/`md:` and surfaces the user inline under the token name
 * on mobile so no data is lost.
 *
 * This test asserts the responsive classes are present in the rendered
 * markup so a future refactor can't silently drop them.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/api-tokens",
}));

const sampleTokens = [
  {
    id: "tok1",
    name: "iOS app",
    permissions: ["*"],
    lastUsedAt: "2026-05-08T12:00:00Z",
    expiresAt: null,
    createdAt: "2026-05-01T08:00:00Z",
    revoked: false,
    user: { id: "u1", username: "marc" },
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: sampleTokens,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "marc",
      email: "marc@example.com",
      role: "ADMIN",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ApiTokenOverviewSection } from "../api-token-overview-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ApiTokenOverviewSection />
    </I18nProvider>,
  );
}

describe("ApiTokenOverviewSection — responsive", () => {
  it("wraps the table in an overflow-x-auto container", () => {
    const html = render();
    expect(html).toContain("overflow-x-auto");
  });

  it("hides the user column until sm:", () => {
    const html = render();
    // <th> for user column carries the hidden-then-table-cell pattern.
    expect(html).toMatch(/<th[^>]*hidden[^>]*sm:table-cell[^>]*>/);
  });

  it("hides the last-used and created columns until md:", () => {
    const html = render();
    // Both columns share the same md: pattern; expect at least two
    // matches (one per column).
    const matches = html.match(/hidden[^"]*md:table-cell/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces the username inline under the token name on mobile", () => {
    const html = render();
    // The mobile-only fallback span carries `sm:hidden` and the
    // username text. Without it, hiding the user column would lose
    // information on phones.
    expect(html).toContain("sm:hidden");
    // Username appears twice: once in the hidden user column TD, once
    // in the inline mobile fallback span.
    const userOccurrences = (html.match(/marc/g) ?? []).length;
    expect(userOccurrences).toBeGreaterThanOrEqual(2);
  });

  it("uses a smaller card padding on mobile (p-4 sm:p-6)", () => {
    const html = render();
    // The card root carries the responsive padding to leave more room
    // for the table within a 360 CSS-px viewport.
    expect(html).toMatch(/class="[^"]*\bp-4\b[^"]*sm:p-6/);
  });
});
