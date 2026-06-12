/**
 * `<DashboardHeader>` greeting contract.
 *
 * The greeting line lives in the hero band when that renders; the hero
 * is optional (snapshot flag off, or hidden via the dashboard-layout
 * toggle), so the page feeds `showGreeting` from its hero gate and the
 * header restores the pre-hero greeting paragraph for exactly those
 * mounts. Pinned here:
 *
 *   1. `showGreeting` renders the greeting line (with the `min-h-5`
 *      line-box reservation that keeps the header height stable through
 *      the post-hydration name personalisation);
 *   2. without the prop (the hero owns the greeting) the line is absent
 *      — no duplicate greeting above the hero band;
 *   3. the SSR pass renders the name-less fallback (hydration-safe).
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { username: "tester", timezone: "Europe/Berlin" },
  }),
}));

import { DashboardHeader } from "../dashboard-header";

function renderSSR(node: React.ReactElement, locale: "en" | "de" = "de") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<DashboardHeader> — greeting", () => {
  it("renders the greeting line when the hero is hidden (showGreeting)", () => {
    const html = renderSSR(
      <DashboardHeader onQuickEntry={() => undefined} showGreeting />,
    );
    expect(html).toContain('data-slot="dashboard-header-greeting"');
    // SSR pass: name-less fallback (personalises post-hydration only).
    expect(html).toContain("willkommen zurück.");
    // Reserved line box keeps the header height stable through the
    // post-hydration personalisation swap.
    expect(html).toMatch(/data-slot="dashboard-header-greeting"[^>]*>/);
    expect(html).toContain("min-h-5");
  });

  it("renders NO greeting line when the hero band owns it (default)", () => {
    const html = renderSSR(<DashboardHeader onQuickEntry={() => undefined} />);
    expect(html).not.toContain('data-slot="dashboard-header-greeting"');
    expect(html).not.toContain("willkommen zurück.");
    // The title itself stays.
    expect(html).toContain("Dashboard");
  });
});
