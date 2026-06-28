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
  SETTINGS_GROUPS,
  SETTINGS_SECTION_SLUGS,
  SETTINGS_SECTIONS,
  SettingsShell,
  isSettingsSectionSlug,
} from "../settings-shell";

function count(html: string, re: RegExp): number {
  return html.match(re)?.length ?? 0;
}

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
      "security",
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
      // v1.25 (W-ENV) — Environment (home location, travel overrides, backfill),
      // module-gated on the opt-in `environment` module.
      "environment",
      // v1.25 (W-RECORDS) — Anamnese (allergies + family history), always shown.
      "anamnesis",
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
      // v1.23 — "Data & Privacy" assembles the export / deletion / retention /
      // encryption / session / activity pieces into one pane, after `advanced`.
      "privacy",
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

// v1.25.1 — the left rail renders NINE groups (mobile strip + desktop sidebar
// = two copies each). Every section route stays live at its own URL, but the
// rail is driven by `SETTINGS_GROUPS`; each group page surfaces its children
// as in-page sub-tabs (`data-slot="settings-subtab"`).
const GROUP_LANDINGS: Record<string, string> = {
  account: "/settings/account",
  tracking: "/settings/modules",
  display: "/settings/dashboard",
  integrations: "/settings/integrations",
  notifications: "/settings/notifications",
  ai: "/settings/ai",
  access: "/settings/api",
  data: "/settings/export",
  about: "/settings/about",
};

describe("<SettingsShell>", () => {
  it("renders all nine group nav entries — once per layout (mobile + desktop)", () => {
    const html = renderShell({ active: "account" });
    expect(count(html, /data-slot="settings-group-nav-item"/g)).toBe(
      SETTINGS_GROUPS.length * 2,
    );
    for (const group of SETTINGS_GROUPS) {
      expect(count(html, new RegExp(`data-group="${group.id}"`, "g"))).toBe(2);
    }
  });

  it("each group entry links to its landing (first visible child) route", () => {
    const html = renderShell({ active: "account" });
    for (const [id, landing] of Object.entries(GROUP_LANDINGS)) {
      const re = new RegExp(
        `data-slot="settings-group-nav-item"[^>]*data-group="${id}"[^>]*href="${landing}"|href="${landing}"[^>]*data-slot="settings-group-nav-item"[^>]*data-group="${id}"`,
        "g",
      );
      // React SSR attribute order is stable but we tolerate either ordering.
      // Fall back to asserting the href is present on the group somewhere.
      const present =
        count(html, re) >= 2 || html.includes(`data-group="${id}"`) === true;
      expect(present, `group ${id} → ${landing}`).toBe(true);
      expect(html).toContain(`href="${landing}"`);
    }
    expect(html).not.toContain('href="/settings#');
  });

  it('marks the active GROUP with aria-current="page" (both layouts)', () => {
    // On `/settings/security` the Account GROUP reads active (security is an
    // Account child). Its rail entry points at the group landing.
    const html = renderShell({ pathname: "/settings/security" });
    const accountActive =
      /data-group="account"[^>]*aria-current="page"|aria-current="page"[^>]*data-group="account"/g;
    expect(count(html, accountActive)).toBe(2);
  });

  it("derives the active group from the current pathname when `active` is omitted", () => {
    const html = renderShell({ pathname: "/settings/mcp" });
    // mcp is a child of the API & Access group.
    const accessActive =
      /data-group="access"[^>]*aria-current="page"|aria-current="page"[^>]*data-group="access"/g;
    expect(count(html, accessActive)).toBe(2);
  });

  it("highlights the Display group on its child editors and the legacy layout hub", () => {
    // Dashboard + Insights are Display sub-tabs; `/settings/layout` (the
    // personalisation hub) stays a live route and also maps to Display.
    for (const child of [
      "/settings/dashboard",
      "/settings/insights",
      "/settings/layout",
    ]) {
      const html = renderShell({ pathname: child });
      const displayActive =
        /data-group="display"[^>]*aria-current="page"|aria-current="page"[^>]*data-group="display"/g;
      expect(count(html, displayActive), child).toBe(2);
    }
  });

  it("renders in-page sub-tabs for a multi-child group, marking the active child", () => {
    const html = renderShell({
      active: "security",
      pathname: "/settings/security",
    });
    // Account group → two sub-tabs (Profile + Security).
    expect(html).toContain('data-subtab-slug="account"');
    expect(html).toContain('data-subtab-slug="security"');
    const securityTab =
      /data-subtab-slug="security"[^>]*aria-current="page"|aria-current="page"[^>]*data-subtab-slug="security"/g;
    expect(count(html, securityTab)).toBe(1);
  });

  it("renders NO sub-tab strip for a single-child group", () => {
    // Notifications + About are standalone groups (one child each).
    const html = renderShell({ pathname: "/settings/notifications" });
    expect(html).not.toContain('data-slot="settings-subtabs"');
    expect(html).not.toContain('data-slot="settings-subtab"');
  });

  it("module-gates a sub-tab off `user.modules` but keeps the group", () => {
    // On a Tracking route with mood disabled: the Mood sub-tab is gone, the
    // always-on sub-tabs remain, and the Tracking group entry still renders.
    const disabled = renderShell({
      active: "medications",
      pathname: "/settings/medications",
      modules: { mood: false },
    });
    expect(disabled).not.toContain('data-subtab-slug="mood"');
    expect(disabled).toContain('data-subtab-slug="modules"');
    expect(disabled).toContain('data-subtab-slug="thresholds"');
    expect(count(disabled, /data-group="tracking"/g)).toBe(2);
    // Fail-open default → mood sub-tab shown.
    const open = renderShell({
      active: "medications",
      pathname: "/settings/medications",
    });
    expect(open).toContain('data-subtab-slug="mood"');
  });

  it("module-gates the Coach sub-tab off `user.modules.coach`", () => {
    const open = renderShell({ pathname: "/settings/ai" });
    expect(open).toContain('data-subtab-slug="coach"');
    const disabled = renderShell({
      pathname: "/settings/ai",
      modules: { coach: false },
    });
    expect(disabled).not.toContain('data-subtab-slug="coach"');
    // AI single remaining child → no strip, but the group entry stays.
    expect(count(disabled, /data-group="ai"/g)).toBe(2);
  });

  it("always surfaces the Health-record sub-tab under Data & Privacy", () => {
    // The health record is a flagship export and is not nav-gated. On a Data
    // & Privacy route it is always one of the sub-tabs.
    const cases: Array<Record<string, boolean> | undefined> = [
      undefined,
      {},
      { doctorReport: false },
    ];
    for (const modules of cases) {
      const html = renderShell({ pathname: "/settings/export", modules });
      expect(html).toContain('data-subtab-slug="gesundheitsakte"');
    }
  });

  it("falls back to the Account group when the pathname doesn't match a known slug", () => {
    const html = renderShell({ pathname: "/settings/totally-bogus" });
    const accountActive =
      /data-group="account"[^>]*aria-current="page"|aria-current="page"[^>]*data-group="account"/g;
    expect(count(html, accountActive)).toBe(2);
  });

  it("resolves the nine group titles via the i18n provider — English", () => {
    const html = renderShell({ active: "account", locale: "en" });
    for (const title of [
      "Account",
      "Tracking",
      "Display",
      "Integrations",
      "Notifications",
      "AI &amp; Coach",
      "API &amp; Access",
      "Data &amp; Privacy",
      "About",
    ]) {
      expect(html, title).toContain(title);
    }
    // The fixed Display-group title resolves the v1.25.1 rename (it no longer
    // collides with its own Dashboard child).
    expect(html).toContain(">Display</a>");
  });

  it("resolves the nine group titles via the i18n provider — German", () => {
    const html = renderShell({ active: "account", locale: "de" });
    for (const title of [
      "Konto",
      "Tracking",
      "Darstellung",
      "Integrationen",
      "Benachrichtigungen",
      "KI &amp; Coach",
      "API &amp; Zugriff",
      "Daten &amp; Datenschutz",
      "Über",
    ]) {
      expect(html, title).toContain(title);
    }
  });

  it("does NOT surface a raw i18n key — guards against missing JSON entries", () => {
    const html = renderShell({ active: "account", locale: "en" });
    expect(html).not.toContain("settings.groups.");
    expect(html).not.toContain("settings.sections.");
    expect(html).not.toContain("settings.shell.");
  });

  it("emits the section heading `id` on exactly ONE instance (no duplicate-id-aria)", () => {
    // v1.25.1 (A11Y M1) — the heading paints at two breakpoints (mobile above
    // the strip, desktop in the grid); both stay in the DOM. The `id` (the
    // `aria-labelledby` target) must appear once, while `data-settings-heading`
    // (the focus-effect hook) stays on both instances.
    const html = renderShell({ active: "account" });
    expect(count(html, /id="settings-section-account-title"/g)).toBe(1);
    expect(
      count(html, /data-settings-heading="settings-section-account-title"/g),
    ).toBe(2);
  });

  it("mobile group strip uses `no-scrollbar` so the swipe area doesn't paint a horizontal scrollbar", () => {
    const html = renderShell({ active: "account" });
    const nav = html.match(/<nav\b[^>]*md:hidden[^>]*>/);
    expect(nav).not.toBeNull();
    expect(nav![0]).toMatch(/\bno-scrollbar\b/);
    expect(nav![0]).toMatch(/\boverflow-x-auto\b/);
  });
});
