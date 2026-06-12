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
}) {
  mockPathnameRef.value = props.pathname ?? "/settings/account";
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
    // IW-D merged it into `thresholds`.
    // v1.8.7.1 — `sources` (Sources) is its own slug again, sitting
    // between `thresholds` (Targets) and `ai`.
    // v1.15.18 — `insights` sits between `dashboard` and `thresholds`: the
    // overview-arrange + pill-sort customise surface for `/insights`.
    // v1.16.10 — `medications` sits between `insights` and `thresholds`:
    // the view-preference + manual-order customise surface for
    // `/medications`, reached from the page header's Settings2 glyph.
    // v1.17 — `mood` sits between `medications` and `thresholds`: the
    // mood-tag management surface (groups, custom tags, hide/archive,
    // picker order), reached from the /mood page header's wrench glyph.
    expect([...SETTINGS_SECTION_SLUGS]).toEqual([
      "account",
      "integrations",
      "notifications",
      "dashboard",
      "insights",
      "medications",
      "mood",
      "thresholds",
      "sources",
      "ai",
      "api",
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
    expect(html).toContain("Dashboard");
    expect(html).toContain("Insights");
    // v1.16.10 — the /medications customise surface is its own nav entry
    // between Insights and Targets.
    expect(html).toContain('href="/settings/medications"');
    expect(html).toContain("Medications");
    // v1.17 — the mood-tag management surface sits between Medications
    // and Targets.
    expect(html).toContain('href="/settings/mood"');
    expect(html).toContain("Mood tags");
    // The ampersand is HTML-escaped by React SSR — assert on the encoded
    // form so we don't accidentally match a parser that double-escapes.
    expect(html).toContain("API &amp; Tokens");
    // v1.4.16 phase B7: the consolidated Export section is a top-level
    // entry in the sidebar; the link must be present in both locales.
    expect(html).toContain('href="/settings/export"');
    expect(html).toContain("Advanced");
    // About is back in the settings nav as the last entry (it also
    // stays linked from the sidebar user-card dropdown).
    expect(html).toContain('href="/settings/about"');
    // v1.8.7.1 — Targets and Sources are two separate nav entries again.
    expect(html).toContain('href="/settings/thresholds"');
    expect(html).toContain('href="/settings/sources"');
    expect(html).toContain("Targets");
    // v1.12.0 — the source-priority entry adopts the canonical
    // "Source priority" / "Quellen-Priorität" label (handover §5).
    expect(html).toContain("Source priority");
  });

  it("resolves every section title via the i18n provider — German", () => {
    const html = renderShell({ active: "account", locale: "de" });
    expect(html).toContain("Konto");
    expect(html).toContain("Integrationen");
    // v1.9.0 — back to the shorter "Benachrichtigungen" (single-line; the
    // compound "Benachrichtigungs-Kanäle" wrapped). The `/notifications`
    // inbox now shares the "Benachrichtigungen" label.
    expect(html).toContain("Benachrichtigungen");
    // v1.4.3: the Settings sub-section formerly labelled "Übersicht" is now
    // "Dashboard" (matching the term users see in the main nav). The
    // per-metric overrides moved out into their own "Persönliche Zielwerte"
    // section, which is the new entry below the Dashboard one.
    expect(html).toContain("Dashboard");
    // v1.16.10 — the /medications customise surface ("Medikamente").
    expect(html).toContain('href="/settings/medications"');
    expect(html).toContain("Medikamente");
    // v1.17 — the mood-tag management surface ("Stimmungs-Tags").
    expect(html).toContain('href="/settings/mood"');
    expect(html).toContain("Stimmungs-Tags");
    // v1.8.7.1 — Targets and Sources are two separate German nav
    // entries again: "Zielwerte" and "Quellen".
    expect(html).toContain("Zielwerte");
    expect(html).toContain("Quellen");
    // v1.8.7.1 — the AI Insights section is named "KI-Auswertungen" in
    // German (the "KI" prefix makes the AI nature explicit).
    expect(html).toContain("KI-Auswertungen");
    // API & Tokens is identical in both locales (proper noun + ampersand)
    expect(html).toContain("API &amp; Tokens");
    expect(html).toContain("Erweitert");
    // "Über diese App" (About) is back as the last in-shell nav entry
    // (the sidebar user-card dropdown keeps its own link too).
    expect(html).toContain('href="/settings/about"');
    // v1.8.7.1 — both Targets and Sources nav entries are present.
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
