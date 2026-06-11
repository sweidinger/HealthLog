import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// SSR test render has no Next.js app-router context; stub the two
// navigation hooks the FAB uses. The pathname is mutable so the
// hide-on-coach-page branch can be exercised.
let mockPathname = "/insights";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => mockPathname,
}));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";

import { isNudgeUnread, LayoutCoachFab } from "../layout-coach-fab";

/**
 * v1.16.8 — the FAB is a permanent launcher on every authenticated
 * page (mounted once in `<AuthShell>`). The v1.16.1 nudge-only bubble
 * folded into it: an unseen proactive `COACH_NUDGE` paints a small
 * unread dot on the button's corner instead of toggling the whole
 * button, and the FAB hides itself on the Coach page.
 *
 * Project convention is SSR-only tests (no `@testing-library/react`).
 * On first paint the nudge-status query has no data, so the dot must
 * be absent while the launcher itself renders; the unread derivation
 * is pinned through the exported pure helper.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<LayoutCoachFab>", () => {
  it("returns nothing when no <CoachLaunchProvider> is mounted", () => {
    mockPathname = "/insights";
    const html = render(<LayoutCoachFab />);
    expect(html).not.toContain('data-slot="coach-fab"');
  });

  it("renders the always-on launcher under the provider (no nudge needed)", () => {
    mockPathname = "/";
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    expect(html).toContain('data-slot="coach-fab"');
    // Accessible name carries the launcher label, not the nudge copy.
    expect(html).toContain('aria-label="Open the Coach"');
    // Fixed bottom-right, above the mobile bottom-nav band.
    expect(html).toContain("fixed right-4");
    expect(html).toContain(
      "bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)]",
    );
  });

  it("paints no unread dot on first paint (no nudge-status data yet)", () => {
    mockPathname = "/";
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    expect(html).not.toContain('data-slot="coach-fab-unread"');
    expect(html).not.toContain('data-unread="true"');
  });

  it("hides itself on the Coach page", () => {
    mockPathname = "/insights/coach";
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    expect(html).not.toContain('data-slot="coach-fab"');
  });

  it("yields to the data-list selection bar via the :has() gate", () => {
    mockPathname = "/measurements";
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    // The selection bar's delete action lands in the same lower-right
    // band; the FAB carries a CSS gate keyed off the bar's data-slot.
    expect(html).toContain("selection-action-bar");
  });
});

describe("isNudgeUnread", () => {
  const nudgedAt = "2026-06-09T05:15:00.000Z";

  it("is false without status or without a nudge", () => {
    expect(isNudgeUnread(undefined, null)).toBe(false);
    expect(isNudgeUnread({ nudgedAt: null, unread: false }, null)).toBe(false);
  });

  it("is true for a server-unread nudge the device has not seen", () => {
    expect(isNudgeUnread({ nudgedAt, unread: true }, null)).toBe(true);
    expect(isNudgeUnread({ nudgedAt, unread: true }, "2026-01-01")).toBe(true);
  });

  it("is false once the server counts the nudge as read", () => {
    // The user sent a Coach message after the nudge.
    expect(isNudgeUnread({ nudgedAt, unread: false }, null)).toBe(false);
  });

  it("is false once this device stored the matching seen stamp", () => {
    expect(isNudgeUnread({ nudgedAt, unread: true }, nudgedAt)).toBe(false);
  });
});
