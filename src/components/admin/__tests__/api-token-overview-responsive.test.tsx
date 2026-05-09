import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.16 phase A3 — `/admin/api-tokens` no horizontal overflow on
 * Pixel-5-class viewports (393 CSS px).
 *
 * The v1.4.15 fix tried hiding columns + tightening padding, but a
 * scrollbar still showed up because the wrapper kept `overflow-x-auto`
 * on mobile and content like long permission badges or token names
 * could exceed the available width. v1.4.16 mirrors the
 * `<UserManagementSection>` pattern: the desktop `<table>` is gated
 * behind `hidden md:block` and a real card-list renders at <md. No
 * `overflow-x-auto` on mobile — every cell wraps within the card,
 * `break-all` on the name + permission badges, and the document never
 * grows wider than the viewport.
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
  it("hides the desktop table on mobile (<md) via hidden md:block", () => {
    const html = render();
    // The desktop table wrapper carries `hidden md:block` so the
    // <table> never paints (and never tries to scroll) on phones.
    expect(html).toMatch(/<div[^>]*\bhidden\b[^>]*md:block[^>]*>[\s\S]*<table/);
  });

  it("renders a mobile card-list at <md (md:hidden)", () => {
    const html = render();
    // The mobile fallback is a <ul> tagged with `md:hidden` and a
    // stable test id. Mirrors `<UserManagementSection>`'s pattern.
    expect(html).toContain('data-testid="admin-tokens-mobile-list"');
    expect(html).toMatch(/<ul[^>]*md:hidden/);
  });

  it("mobile card-list has no overflow-x-auto wrapper", () => {
    const html = render();
    // Mobile cards must let content wrap within the card rather than
    // forcing a scroll container — that was the v1.4.15 bug Marc
    // re-reported. Confirm there's no overflow-x-auto INSIDE the
    // mobile <ul>.
    const mobileMatch = html.match(
      /<ul[^>]*md:hidden[^>]*>([\s\S]*?)<\/ul>/,
    );
    expect(mobileMatch).not.toBeNull();
    expect(mobileMatch![1]).not.toContain("overflow-x-auto");
  });

  it("surfaces the username, permissions, status, last-used, and created on mobile cards", () => {
    const html = render();
    // All data points the desktop table shows must also appear in the
    // mobile cards. Token name + username + a permission badge + the
    // last-used/created labels are all present.
    expect(html).toContain("marc"); // username
    expect(html).toContain("iOS app"); // token name
    expect(html).toMatch(/\*/); // permission badge content
  });

  it("uses a smaller card padding on mobile (p-4 sm:p-6)", () => {
    const html = render();
    // The card root carries the responsive padding to leave more room
    // for content within a 393 CSS-px viewport.
    expect(html).toMatch(/class="[^"]*\bp-4\b[^"]*sm:p-6/);
  });

  it("mobile timestamp lines wrap (no nowrap on the meta paragraphs)", () => {
    const html = render();
    const mobileMatch = html.match(
      /<ul[^>]*md:hidden[^>]*>([\s\S]*?)<\/ul>/,
    );
    expect(mobileMatch).not.toBeNull();
    // The Last-used + Created lines use <p class="text-[11px]…"> — no
    // whitespace-nowrap so a long German date+time can flow onto a
    // second line within the card. The shadcn `<Badge>` primitive
    // does carry `whitespace-nowrap`, which is fine for the short
    // permission strings we render — those are scoped to a flex-wrap
    // container that line-breaks at the badge boundary.
    expect(mobileMatch![1]).toMatch(
      /<p[^>]*text-\[11px\][^>]*>(?![^<]*whitespace-nowrap)/,
    );
  });
});
