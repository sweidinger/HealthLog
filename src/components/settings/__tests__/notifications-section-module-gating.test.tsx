/**
 * v1.18.0 (S4) — module-gated per-type visibility on the consolidated
 * "Benachrichtigungen" reminder-types home.
 *
 * The mood reminder shows only when the `mood` module is enabled; the Coach
 * nudge only when `coach` is enabled. Low-stock maps to the medications CORE
 * domain (always shown). The gate fails OPEN, so a `/me` payload without a
 * module map keeps every card visible.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/notifications",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The auth mock is driven per-test via a mutable ref so each render can pick
// a different module map without re-mocking the module.
const authRef: { modules?: Record<string, boolean> } = {};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "t", role: "USER", modules: authRef.modules },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { NotificationsSection } from "../notifications-section";

function render(modules?: Record<string, boolean>) {
  authRef.modules = modules;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <NotificationsSection />
    </I18nProvider>,
  );
}

describe("<NotificationsSection> module-gated reminder types", () => {
  it("shows mood + coach cards when no module map (fails open)", () => {
    const html = render(undefined);
    expect(html).toContain('id="mood-reminder"');
    expect(html).toContain('id="coach-nudge"');
    expect(html).toContain('id="low-stock"');
  });

  it("hides the mood card when the mood module is disabled", () => {
    const html = render({ mood: false });
    expect(html).not.toContain('id="mood-reminder"');
    // Coach + low-stock are unaffected.
    expect(html).toContain('id="coach-nudge"');
    expect(html).toContain('id="low-stock"');
  });

  it("hides the coach card when the coach module is disabled", () => {
    const html = render({ coach: false });
    expect(html).not.toContain('id="coach-nudge"');
    expect(html).toContain('id="mood-reminder"');
    expect(html).toContain('id="low-stock"');
  });

  it("always shows low-stock (medications is a CORE domain)", () => {
    const html = render({ mood: false, coach: false });
    expect(html).toContain('id="low-stock"');
    expect(html).not.toContain('id="mood-reminder"');
    expect(html).not.toContain('id="coach-nudge"');
  });

  it("drops the channels / inbox cross-links and the Vorsorge block (D5)", () => {
    // v1.18.1 (D5) — the page is lean: no section blurb, no channels/inbox
    // cross-links, and no embedded Vorsorge editor (it has its own page).
    const html = render({});
    expect(html).not.toContain('data-slot="notifications-channels-cross-link"');
    expect(html).not.toContain('data-slot="notifications-inbox-cross-link"');
    // The three reminder-type cards remain.
    expect(html).toContain('id="mood-reminder"');
    expect(html).toContain('id="low-stock"');
    expect(html).toContain('id="coach-nudge"');
  });
});
