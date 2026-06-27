import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// `<SettingsShell>` reads the active route from `usePathname()`. We stub
// next/navigation so the SSR test render works without an App-Router
// runtime. The mock reads `mockPathnameRef.value` at call-time (not at
// module-load) so each test can mutate the ref before rendering and the
// shell will see the updated path.
const mockPathnameRef = { value: "/settings/account" };
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathnameRef.value,
}));

// v1.18.0 (S5) — the shell module-gates per-submodule nav entries off
// `useAuth().user.modules`. The mock returns a user whose modules map is
// mutated per-test via `mockModulesRef`. `undefined` (the default) means
// every gate fails open, so all entries render.
const mockModulesRef: { value: Record<string, boolean> | undefined } = {
  value: undefined,
};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER", modules: mockModulesRef.value },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import {
  SETTINGS_SECTION_SLUGS,
  SETTINGS_SECTIONS,
  SettingsShell,
  isSettingsSectionSlug,
} from "../settings-shell";

function renderShell(props: {
  active?: (typeof SETTINGS_SECTION_SLUGS)[number];
  pathname?: string;
  locale?: "en" | "de";
  modules?: Record<string, boolean>;
}) {
  mockPathnameRef.value = props.pathname ?? "/settings/account";
  mockModulesRef.value = props.modules;
  return renderToStaticMarkup(
    <I18nProvider initialLocale={props.locale ?? "en"}>
      <SettingsShell active={props.active}>
        <div>section body</div>
      </SettingsShell>
    </I18nProvider>,
  );
}

describe("SETTINGS_SECTION_SLUGS", () => {
  it("declares every section", () => {
    // Order matters — `generateStaticParams()` and the sidebar derive their
    // ordering from this constant, so a reorder is a behaviour change.
    // v1.4.3 split the dashboard panel: layout stays under `dashboard`,
    // per-metric overrides moved to their own `thresholds` slug so it's
    // a top-level entry in the settings nav.
    // v1.4.16 phase B7 added the consolidated `export` section between
    // `api` and `advanced` so every "give me my data out" path lives in
    // one place.
    // v1.4.25 W5e added `sources` between `thresholds` and `ai`; v1.4.34
    // IW-D merged it into `thresholds`; v1.8.7.1 split it back out.
    // v1.18.0 (S3) — `sources` is no longer a standalone slug: source
    // priority folded into Settings → Integrations as the "Sources"
    // sub-tab. `/settings/sources` 301-redirects to `/settings/integrations`.
    // v1.15.18 — `insights` sits between `dashboard` and `thresholds`: the
    // overview-arrange + pill-sort customise surface for `/insights`.
    // v1.16.10 — `medications` sits between `insights` and `thresholds`:
    // the view-preference + manual-order customise surface for
    // `/medications`, reached from the page header's Settings2 glyph.
    // v1.17 — `mood` sits between `medications` and `thresholds`: the
    // mood-tag management surface (groups, custom tags, hide/archive,
    // picker order), reached from the /mood page header's wrench glyph.
    // v1.17.1 (F-2) — `layout` is the one "Layout & Personalization" home
    // and sits after `notifications`. The four personalization editor
    // slugs (`dashboard`, `insights`, `medications`, `mood`) keep their
    // routes so deep links resolve, but they are reached through the
    // Layout hub instead of four standalone nav entries.
    // v1.18.0 (S4) — the standalone `reminders` hub is gone; reminder TYPES
    // live in `notifications`, each gated on its module. `/settings/reminders`
    // 301-redirects to `/settings/notifications`.
    // v1.18.0 — `modules` ("Was du trackst") sits right after `account` as
    // the single front door for enabling/disabling secondary domains.
    // v1.18.0 (S5) — `gesundheitsakte` (the full health-record export) lifts
    // out of Export & Import into its own top-level entry, before `export`;
    // `coach` gathers the Coach preference cards out of the AI section and
    // sits right after `ai`.
    // v1.18.1 (D4) — `channels` + `sources` split out of the Integrations
    // sub-tabs into their own left-side entries, right after `integrations`.
    // v1.18.7 — `labs`, `illness`, `vorsorge` move into the shell as
    // first-class sections, right after `mood` (the three were standalone
    // `ModuleSettingsFrame` pages).
    // v1.18.7 — `sharing` (clinician share links) sits directly after
    // `gesundheitsakte`, before `export`: minting a read-only link to the
    // health record belongs next to the health-record export.
    expect([...SETTINGS_SECTION_SLUGS]).toEqual([
      "account",
      "modules",
      "integrations",
      "channels",
      "sources",
      "notifications",
      "layout",
      "dashboard",
      "insights",
      "medications",
      "mood",
      "labs",
      "illness",
      "vorsorge",
      "thresholds",
      "ai",
      "coach",
      "api",
      "mcp",
      "gesundheitsakte",
      "sharing",
      "export",
      "advanced",
      "about",
    ]);
  });

  it("`isSettingsSectionSlug` accepts known slugs and rejects others", () => {
    for (const slug of SETTINGS_SECTION_SLUGS) {
      expect(isSettingsSectionSlug(slug)).toBe(true);
    }
    expect(isSettingsSectionSlug("nope")).toBe(false);
    expect(isSettingsSectionSlug("")).toBe(false);
    expect(isSettingsSectionSlug("Account")).toBe(false); // case-sensitive
  });

  it("each section has a non-empty title key under settings.sections.<slug>", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.titleKey).toBe(`settings.sections.${section.slug}.title`);
    }
  });
});

describe("<SettingsShell>", () => {
  it("renders every navigable section link — once for the mobile strip and once for the desktop sidebar", () => {
    const html = renderShell({ active: "account" });
    // Every slug — including `about`, which returned to the shell nav
    // as the last entry after living dropdown-only since v1.4.33 IW7 —
    // renders in both layouts.
    const navigableSlugs = SETTINGS_SECTIONS.map((section) => section.slug);
    for (const slug of navigableSlugs) {
      const matches = html.match(new RegExp(`href="/settings/${slug}"`, "g"));
      // Two renders — mobile strip + desktop sidebar — guarantee the link
      // exists in both layouts. Tablet/desktop hide the strip with `md:`,
      // but the markup is always present so it's keyboard-discoverable
      // before media queries resolve.
      expect(matches?.length ?? 0).toBe(2);
    }
  });

  it("links use the correct `/settings/<slug>` href — regression guard against typos", () => {
    const html = renderShell({ active: "account" });
    // Spot-check a couple of slugs that have historic anchor aliases (e.g.
    // `/settings#withings` → `/settings/integrations`) — they must NOT
    // sneak back in.
    expect(html).toContain('href="/settings/integrations"');
    expect(html).toContain('href="/settings/ai"');
    expect(html).not.toContain('href="/settings#');
    expect(html).not.toContain('href="/settings"');
  });

  it('marks the active section with aria-current="page" (and only that one)', () => {
    const html = renderShell({ active: "notifications" });
    // Both layouts emit the active link, so two `aria-current="page"`.
    const occurrences = html.match(/aria-current="page"/g);
    expect(occurrences?.length ?? 0).toBe(2);

    // And the active link is on the notifications href. Attribute order
    // in React SSR is alphabetic, so `aria-current` precedes `href` —
    // the regex deliberately doesn't pin order to stay robust against
    // future React renderer changes.
    const activeLinkRegex =
      /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/settings\/notifications"|<a\b[^>]*\bhref="\/settings\/notifications"[^>]*\baria-current="page"/g;
    expect(html.match(activeLinkRegex)?.length ?? 0).toBe(2);
  });

  it("derives the active slug from the current pathname when `active` is omitted", () => {
    const html = renderShell({ pathname: "/settings/api" });
    const activeLinkRegex =
      /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/settings\/api"|<a\b[^>]*\bhref="\/settings\/api"[^>]*\baria-current="page"/g;
    expect(html.match(activeLinkRegex)?.length ?? 0).toBe(2);
  });

  it("highlights the Layout hub when on a Layout child editor (v1.17.1 F-2)", () => {
    // On `/settings/dashboard` (a Layout child reached through the hub) the
    // Layout nav entry must read active even though Dashboard has no nav
    // entry of its own. Both layouts emit the active link → two matches.
    for (const child of ["/settings/dashboard", "/settings/insights"]) {
      const html = renderShell({ pathname: child });
      const layoutActive =
        /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/settings\/layout"|<a\b[^>]*\bhref="\/settings\/layout"[^>]*\baria-current="page"/g;
      expect(html.match(layoutActive)?.length ?? 0).toBe(2);
    }
  });

  it("highlights the Layout hub when the active prop is a Layout child", () => {
    // The page passes `active={section}` explicitly; a child slug must
    // still resolve onto the Layout hub for nav highlighting.
    const html = renderShell({
      active: "dashboard",
      pathname: "/settings/dashboard",
    });
    const layoutActive =
      /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/settings\/layout"|<a\b[^>]*\bhref="\/settings\/layout"[^>]*\baria-current="page"/g;
    expect(html.match(layoutActive)?.length ?? 0).toBe(2);
  });

  it("module-gates the Stimmung entry off `user.modules.mood` (v1.18.0 S5)", () => {
    // Fail-open default: mood undefined → entry shown.
    expect(renderShell({ active: "account" })).toContain(
      'href="/settings/mood"',
    );
    // Explicitly disabled → entry hidden.
    const disabled = renderShell({
      active: "account",
      modules: { mood: false },
    });
    expect(disabled).not.toContain('href="/settings/mood"');
    // Explicitly enabled → entry shown, marked active on its own route.
    const enabled = renderShell({
      active: "mood",
      pathname: "/settings/mood",
      modules: { mood: true },
    });
    const moodActive =
      /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/settings\/mood"|<a\b[^>]*\bhref="\/settings\/mood"[^>]*\baria-current="page"/g;
    expect(enabled.match(moodActive)?.length ?? 0).toBe(2);
  });

  it("module-gates the Coach entry off `user.modules.coach` (v1.18.0 S5)", () => {
    // Fail-open default: coach undefined → entry shown.
    expect(renderShell({ active: "account" })).toContain(
      'href="/settings/coach"',
    );
    // Explicitly disabled → entry hidden.
    const disabled = renderShell({
      active: "account",
      modules: { coach: false },
    });
    expect(disabled).not.toContain('href="/settings/coach"');
  });

  it("always surfaces the Health-record entry, regardless of `doctorReport` (v1.18.6.1)", () => {
    // The health-record (PDF / FHIR) entry is a flagship export capability
    // and is no longer nav-gated: a default/unset modules map shows it, and
    // even an explicit `doctorReport: false` keeps the Settings entry-point
    // reachable. The server-side `/api/export/health-record` route remains
    // the hard enforcement of the opt-out.
    expect(renderShell({ active: "account" })).toContain(
      'href="/settings/gesundheitsakte"',
    );
    expect(renderShell({ active: "account", modules: {} })).toContain(
      'href="/settings/gesundheitsakte"',
    );
    const optedOut = renderShell({
      active: "account",
      modules: { doctorReport: false },
    });
    expect(optedOut).toContain('href="/settings/gesundheitsakte"');
  });

  it("falls back to `account` when the pathname doesn't match a known slug", () => {
    const html = renderShell({ pathname: "/settings/totally-bogus" });
    const activeLinkRegex =
      /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/settings\/account"|<a\b[^>]*\bhref="\/settings\/account"[^>]*\baria-current="page"/g;
    expect(html.match(activeLinkRegex)?.length ?? 0).toBe(2);
  });

  it("resolves every section title via the i18n provider — English", () => {
    const html = renderShell({ active: "account", locale: "en" });
    expect(html).toContain("Account");
    expect(html).toContain("Integrations");
    // v1.9.0 — the section label is back to the shorter "Notifications"
    // (single-line; the longer "Notification channels" wrapped). The
    // `/notifications` inbox now shares the "Notifications" label.
    expect(html).toContain("Notifications");
    // v1.17.1 (F-2) — the dashboard + insights arrangement editors are
    // reached through one hub entry (route stays `/settings/layout`).
    // v1.19.1 (S3) — the nav label now reads "Dashboard" to match where
    // it leads; the route is unchanged.
    expect(html).toContain('href="/settings/layout"');
    expect(html).toContain(">Dashboard</a>");
    // v1.18.1 (D4) — Channels + Sources are their own left-side entries.
    expect(html).toContain('href="/settings/channels"');
    expect(html).toContain('href="/settings/sources"');
    // v1.18.0 (S5) — Medications (Medikamente) and Mood (Stimmung, gated;
    // fail-open mock shows both) are their own nav entries now.
    expect(html).toContain('href="/settings/medications"');
    expect(html).toContain('href="/settings/mood"');
    // The ampersand is HTML-escaped by React SSR — assert on the encoded
    // form so we don't accidentally match a parser that double-escapes.
    expect(html).toContain("API &amp; Tokens");
    // v1.18.0 (S5) — the health record is its own top-level entry.
    expect(html).toContain('href="/settings/gesundheitsakte"');
    expect(html).toContain("Health record");
    // v1.4.16 phase B7: the consolidated Export section is a top-level
    // entry in the sidebar; the link must be present in both locales.
    expect(html).toContain('href="/settings/export"');
    expect(html).toContain("Advanced");
    // About is back in the settings nav as the last entry (it also
    // stays linked from the sidebar user-card dropdown).
    expect(html).toContain('href="/settings/about"');
    // v1.18.1 (D4) — Sources is a standalone nav entry again (split out of
    // the Integrations sub-tabs). Targets keeps its own entry.
    expect(html).toContain('href="/settings/thresholds"');
    expect(html).toContain('href="/settings/sources"');
    expect(html).toContain("Targets");
  });

  it("resolves every section title via the i18n provider — German", () => {
    const html = renderShell({ active: "account", locale: "de" });
    expect(html).toContain("Konto");
    expect(html).toContain("Integrationen");
    // v1.9.0 — back to the shorter "Benachrichtigungen" (single-line; the
    // compound "Benachrichtigungs-Kanäle" wrapped). The `/notifications`
    // inbox now shares the "Benachrichtigungen" label.
    expect(html).toContain("Benachrichtigungen");
    // v1.17.1 (F-2) — the arrangement editors are reached through one hub
    // entry (route stays `/settings/layout`). v1.19.1 (S3) — the nav label
    // reads "Dashboard" in every locale to match where it leads.
    expect(html).toContain('href="/settings/layout"');
    expect(html).toContain(">Dashboard</a>");
    // v1.18.1 (D4) — Channels ("Kanäle") + Sources ("Quellen-Priorität")
    // are their own left-side entries.
    expect(html).toContain('href="/settings/channels"');
    expect(html).toContain("Kanäle");
    // v1.18.0 (S5) — Medications + Mood are their own nav entries now.
    expect(html).toContain('href="/settings/medications"');
    expect(html).toContain('href="/settings/mood"');
    // Targets keeps its German nav entry ("Zielwerte").
    expect(html).toContain("Zielwerte");
    // v1.18.6 (W9) — the AI section is named "KI-Anbieter" in German: the
    // page is about the provider / BYOK, not an "Auswertung".
    expect(html).toContain("KI-Anbieter");
    // API & Tokens is identical in both locales (proper noun + ampersand)
    expect(html).toContain("API &amp; Tokens");
    expect(html).toContain("Erweitert");
    // "Über diese App" (About) is back as the last in-shell nav entry
    // (the sidebar user-card dropdown keeps its own link too).
    expect(html).toContain('href="/settings/about"');
    // v1.18.1 (D4) — Sources is a standalone nav entry again.
    expect(html).toContain('href="/settings/sources"');
  });

  it("does NOT surface the raw key when a translation resolves — guards against missing JSON entries", () => {
    const html = renderShell({ active: "account", locale: "en" });
    expect(html).not.toContain("settings.sections.");
  });

  it("mobile section strip uses `no-scrollbar` so the swipe area doesn't paint a horizontal scrollbar", () => {
    // The 10-section strip is wider than 393 CSS px, so without
    // `no-scrollbar` Chromium/WebKit paints an always-on horizontal
    // scrollbar at the top of every settings page. The class is
    // defined in `globals.css` and combines `scrollbar-width: none`
    // (Firefox) with `::-webkit-scrollbar { display: none }` (everyone
    // else) — scroll behaviour is preserved.
    const html = renderShell({ active: "account" });
    const nav = html.match(/<nav\b[^>]*md:hidden[^>]*>/);
    expect(nav).not.toBeNull();
    expect(nav![0]).toMatch(/\bno-scrollbar\b/);
    expect(nav![0]).toMatch(/\boverflow-x-auto\b/);
  });
});
