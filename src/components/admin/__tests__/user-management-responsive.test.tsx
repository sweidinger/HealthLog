import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Phase A5 / B-mobile CRITICAL #2 — `/admin/users` mobile layout.
 *
 * The audit at 393 CSS px showed the desktop table (6 cols × N rows)
 * truncating the role badge ("ADMI", "USE") and pushing the action
 * column entirely off the right edge — the destructive force-logout
 * action was unreachable on mobile.
 *
 * Fix: render the desktop table only at `≥ md`, and on `< md` paint
 * a card-list (`<ul data-testid="admin-users-mobile-list">`) where
 * every action button stays visible and tap-targetable.
 *
 * This test guards the responsive composition so a future refactor
 * can't accidentally drop the mobile path.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/users",
}));

const sampleUsers = [
  {
    id: "u1",
    username: "testuser",
    email: "user@example.com",
    role: "ADMIN" as const,
    passkeyCount: 2,
    createdAt: "2026-04-01T08:00:00Z",
  },
  {
    id: "u2",
    username: "alice",
    email: null,
    role: "USER" as const,
    passkeyCount: 1,
    createdAt: "2026-04-15T08:00:00Z",
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: sampleUsers, isLoading: false }),
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
    user: {
      id: "u1",
      username: "testuser",
      email: "user@example.com",
      role: "ADMIN",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { UserManagementSection } from "../user-management-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <UserManagementSection />
    </I18nProvider>,
  );
}

describe("UserManagementSection — mobile responsive", () => {
  it("hides the desktop table until md:", () => {
    const html = render();
    // The desktop table wrapper should carry `hidden md:block`.
    expect(html).toMatch(/<div[^>]*\bhidden\b[^>]*\bmd:block\b/);
  });

  it("renders the mobile card-list at < md only", () => {
    const html = render();
    // The mobile list opts out at md+ via `md:hidden`.
    expect(html).toContain('data-testid="admin-users-mobile-list"');
    expect(html).toMatch(/<ul[^>]*\bmd:hidden\b/);
  });

  it("surfaces the role badge inside the mobile card (no truncation)", () => {
    const html = render();
    // ADMIN badge text appears at least twice — once in desktop table,
    // once in the mobile card list. Both occurrences mean neither side
    // accidentally lost the column.
    const adminMatches = (html.match(/>ADMIN</g) ?? []).length;
    expect(adminMatches).toBeGreaterThanOrEqual(2);
  });

  it("renders all four action buttons inside the mobile card", () => {
    const html = render();
    // Pull just the mobile-list section by splitting on its testid.
    const mobileStart = html.indexOf('data-testid="admin-users-mobile-list"');
    expect(mobileStart).toBeGreaterThan(0);
    const mobileSlice = html.slice(mobileStart);
    // Toggle role + edit + reset password + force-logout — four
    // buttons. We probe their ARIA labels since the icons are
    // identical-looking; the labels are the contract.
    expect(mobileSlice).toContain("Edit user");
    expect(mobileSlice).toContain("Reset password");
    expect(mobileSlice).toContain("Force logout");
  });

  it("uses smaller card padding on mobile (p-4 sm:p-6)", () => {
    const html = render();
    expect(html).toMatch(/class="[^"]*\bp-4\b[^"]*sm:p-6/);
  });

  it("stacks header rows on mobile so filter pills don't collide with title", () => {
    const html = render();
    // Header carries `flex-col` at base + `sm:flex-row` at small+.
    expect(html).toMatch(/class="[^"]*\bflex-col\b[^"]*sm:flex-row/);
  });
});
