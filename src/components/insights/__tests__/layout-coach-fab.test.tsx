import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// SSR test render has no Next.js app-router context; stub the two
// navigation hooks the bubble uses.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/insights",
}));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";

import { isNudgeUnread, LayoutCoachFab } from "../layout-coach-fab";

/**
 * v1.16.1 — the layout FAB is nudge-driven now: it renders ONLY while
 * an unseen proactive `COACH_NUDGE` exists (per
 * `/api/insights/coach/nudge-status` + the device-local seen stamp).
 * No permanent launcher remains — the inline pill is the everyday
 * entry point.
 *
 * Project convention is SSR-only tests (no `@testing-library/react`).
 * On first paint the nudge-status query has no data, so the bubble
 * must render nothing; the unread derivation is pinned through the
 * exported pure helper instead.
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
    const html = render(<LayoutCoachFab />);
    expect(html).not.toContain('data-slot="coach-nudge-bubble"');
  });

  it("renders nothing on first paint (no nudge-status data yet)", () => {
    // The bubble only exists for an unseen nudge; before the status
    // query resolves there is nothing to show — no permanent FAB.
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    expect(html).not.toContain('data-slot="coach-nudge-bubble"');
    expect(html).not.toContain('data-slot="coach-launch-fab"');
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
