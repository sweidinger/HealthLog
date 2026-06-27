"use client";

/**
 * `<SettingsShell>` — sidebar + main column shell for the v1.4 settings split.
 *
 * Each section lives at its own route (`/settings/[section]/page.tsx`) and
 * mounts inside this shell. The shell owns nothing but navigation: the active
 * section is read from the route, the section heading + content are rendered
 * by the page itself.
 *
 * Mobile-first per `docs/ui-guidelines.md`:
 *   - <md: section selector renders as a horizontal scroll strip at the top so
 *     a thumb-tap can swap sections without leaving the viewport.
 *   - >=md: sticky 220px sidebar + content column with `max-w-screen-xl`.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Blocks,
  Bot,
  CalendarCheck,
  Download,
  FileHeart,
  FlaskConical,
  Info,
  KeyRound,
  Plug,
  LayoutDashboard,
  Layers,
  Link2,
  Pill,
  Radio,
  Settings2,
  Share2,
  SlidersHorizontal,
  Smile,
  Sparkles,
  Thermometer,
  User,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { scrollBehaviorForUser } from "@/lib/motion";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import type { ModuleKey } from "@/lib/modules/registry";
import {
  SETTINGS_SECTION_SLUGS,
  isSettingsSectionSlug,
  type SettingsSectionSlug,
} from "./section-slugs";
import { SettingsHubBackLink } from "./settings-hub-back-link";

// Re-export so existing call-sites importing from this module keep working.
// New server-side call-sites (e.g. `generateStaticParams()`) should import
// from `./section-slugs` directly, since this file is `"use client"` and
// values exported from a client module become unusable proxies on the
// server. (Discovered the hard way: `SETTINGS_SECTION_SLUGS.map(...)` in
// `generateStaticParams()` blows up at build time when imported through a
// client boundary.)
export {
  SETTINGS_SECTION_SLUGS,
  isSettingsSectionSlug,
  type SettingsSectionSlug,
};

interface SettingsSection {
  slug: SettingsSectionSlug;
  /** i18n key under `settings.sections.<slug>.title`. */
  titleKey: string;
  icon: LucideIcon;
  /**
   * v1.18.0 (S5) — per-submodule entries are listed only when their module
   * is enabled. When set, the nav entry hides if the resolved
   * `useAuth().user.modules` map has the key explicitly `false`. The gate
   * fails OPEN (a missing key reads as enabled) so a stale `/me` payload
   * never blanks an entry. Omitted = always shown (global / CORE entries).
   */
  moduleGate?: ModuleKey;
}

/**
 * Source of truth for the section list that the settings shell renders
 * in its sidebar + mobile chip-strip. Order matches the in-app
 * navigation order. Don't reorder without updating tests.
 *
 * "About" sits at the end of the list. v1.4.33 IW7 had folded it into
 * the sidebar user-card dropdown only, which left `/settings/about` an
 * orphaned route — reachable by URL but discoverable nowhere in the
 * settings navigation. It is now both a regular (last) shell entry and
 * a user-card dropdown item ("Über HealthLog" / "About HealthLog").
 *
 * v1.18.0 (S3) — `sources` is no longer a sidebar entry: source priority
 * folded into Settings → Integrations as the "Sources" sub-tab.
 * `thresholds` (Targets) keeps its own entry, served by the dynamic
 * `[section]` route.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { slug: "account", titleKey: "settings.sections.account.title", icon: User },
  // v1.18.0 — the "Was du trackst" hub. Sits right below Account: the one
  // place to enable/disable the secondary tracking domains.
  {
    slug: "modules",
    titleKey: "settings.sections.modules.title",
    icon: Blocks,
  },
  {
    slug: "integrations",
    titleKey: "settings.sections.integrations.title",
    icon: Link2,
  },
  // v1.18.1 (D4) — Kanäle (delivery channels) split out of the Integrations
  // sub-tabs into its own entry. A channel is a delivery provider.
  {
    slug: "channels",
    titleKey: "settings.sections.channels.title",
    icon: Radio,
  },
  // v1.18.1 (D4) — Quellen (source weighting) split out into its own entry:
  // which connection wins when two report the same metric.
  {
    slug: "sources",
    titleKey: "settings.sections.sources.title",
    icon: Layers,
  },
  // v1.18.0 (S4) — "Benachrichtigungen" is now the single module-gated
  // reminder-types home. The separate "Erinnerungen" hub (a link-only page)
  // is gone; reminder TYPES live here, each row gated on its module.
  {
    slug: "notifications",
    titleKey: "settings.sections.notifications.title",
    icon: Bell,
  },
  // v1.17.1 (F-2) — one "Layout & Personalization" nav entry replaces the
  // four scattered Dashboard / Insights / Medications / Mood "arrange"
  // entries. Those routes still resolve (deep links, page-header cogs, and
  // the hub's own links all work); they are simply reached through the
  // Layout hub now, so "how my app is laid out" reads as one home.
  {
    slug: "layout",
    titleKey: "settings.sections.layout.title",
    icon: LayoutDashboard,
  },
  // v1.18.0 (S5) — Medikamente: medication-specific settings (list view +
  // order + injection sites). Was a hidden child of the Layout hub.
  // v1.18.1 (D3) — medications graduated from a CORE domain to a toggleable
  // module, so this entry now hides when the account turns the module off
  // (the medication data routes stay live; this only hides the surface).
  {
    slug: "medications",
    titleKey: "settings.sections.medications.title",
    icon: Pill,
    moduleGate: "medications",
  },
  // v1.18.0 (S5) — Stimmung: the mood-tag management surface gets its own
  // nav entry, shown only when the mood module is enabled. Was a hidden
  // child of the Layout hub.
  {
    slug: "mood",
    titleKey: "settings.sections.mood.title",
    icon: Smile,
    moduleGate: "mood",
  },
  // v1.18.7 — Labor: the labs customise surface (view, sort, biomarkers)
  // becomes a first-class Settings section, gated on the `labs` module. Was
  // a standalone `ModuleSettingsFrame` page reached from the /labs wrench.
  {
    slug: "labs",
    titleKey: "settings.sections.labs.title",
    icon: FlaskConical,
    moduleGate: "labs",
  },
  // v1.18.7 — Krankheitstagebuch: the illness-journal customise surface
  // (view + order of episodes), gated on the `illness` module. Was a
  // standalone `ModuleSettingsFrame` page reached from the /illness wrench.
  {
    slug: "illness",
    titleKey: "settings.sections.illness.title",
    icon: Thermometer,
    moduleGate: "illness",
  },
  // v1.18.7 — Vorsorge: the preventive-care reminders customise surface
  // (view, order, individual reminders). NOT module-gated — preventive-care
  // reminders are not a toggleable module — so the entry is always shown.
  // Was a standalone `ModuleSettingsFrame` page reached from the /vorsorge
  // wrench.
  {
    slug: "vorsorge",
    titleKey: "settings.sections.vorsorge.title",
    icon: CalendarCheck,
  },
  {
    slug: "thresholds",
    titleKey: "settings.sections.thresholds.title",
    icon: SlidersHorizontal,
  },
  { slug: "ai", titleKey: "settings.sections.ai.title", icon: Sparkles },
  // v1.18.0 (S5) — Coach: the Coach preference cards get their own entry,
  // shown only when the coach module is enabled. The AI entry above keeps
  // provider / model / BYOK configuration.
  {
    slug: "coach",
    titleKey: "settings.sections.coach.title",
    icon: Bot,
    moduleGate: "coach",
  },
  { slug: "api", titleKey: "settings.sections.api.title", icon: KeyRound },
  // v1.22.0 — remote MCP connector. Not module-gated: the card carries its own
  // enable toggle (mirroring `gesundheitsakte`), so the entry-point stays
  // reachable even with the opt-in module off.
  { slug: "mcp", titleKey: "settings.sections.mcp.title", icon: Plug },
  // v1.18.0 (S5) — the full health record (PDF + FHIR R4 + zip package)
  // earns its own home, lifted out of Export & Import.
  //
  // v1.18.6.1 — the nav entry is NOT module-gated. The health record is a
  // flagship export capability; gating its only entry-point on the
  // `doctorReport` opt-out meant a stray toggle in the Modules hub made the
  // whole section vanish with no in-context way back. The entry now always
  // shows. The `doctorReport` module still governs the data layer: the
  // server-side `/api/export/health-record` route remains the hard
  // enforcement (403 `module.disabled` over Bearer when the account opts
  // out), and the Modules hub keeps the toggle for anyone who wants the
  // surface gone elsewhere — but the Settings entry-point stays reachable.
  {
    slug: "gesundheitsakte",
    titleKey: "settings.sections.gesundheitsakte.title",
    icon: FileHeart,
  },
  // v1.18.7 — clinician share links sit next to the health record: minting a
  // time-boxed read-only link is a sharing face of the same data. Not
  // module-gated; the link surface is always available (the public
  // `/c/[token]` view and the `/api/share-links` lifecycle are unchanged).
  {
    slug: "sharing",
    titleKey: "settings.sections.sharing.title",
    icon: Share2,
  },
  {
    slug: "export",
    titleKey: "settings.sections.export.title",
    icon: Download,
  },
  {
    slug: "advanced",
    titleKey: "settings.sections.advanced.title",
    icon: Settings2,
  },
  {
    slug: "about",
    titleKey: "settings.sections.about.title",
    icon: Info,
  },
] as const;

export interface SettingsShellProps {
  /**
   * Optional override for the active section. When omitted the shell reads
   * the active slug from `usePathname()` (the production behaviour). Tests
   * pass an explicit value so they don't need to mock the router.
   */
  active?: SettingsSectionSlug;
  /**
   * v1.18.6.1 — the page heading + subtitle now live in the shell, not in
   * the section body. The shell places them in their own grid row that
   * spans ONLY the content column, so the left nav's first item lines up
   * with the top of the first card by construction — no fixed-height
   * spacer to drift across locales or subtitle line-wraps.
   *
   * Title comes from `settings.sections.<active>.title` when omitted; pass
   * an explicit value for the per-module pages (Vorsorge / Illness / Labs)
   * that stay out of the slug registry. `headingId` keeps the historic
   * `settings-section-<slug>-title` anchor for `aria-labelledby` and the
   * spotlight tour.
   */
  heading?: {
    title: string;
    subtitle: string;
    headingId: string;
    /** Rendered above the heading (e.g. a "← back to hub" link). */
    topSlot?: React.ReactNode;
    /** Rendered inline at the top-right of the heading row. */
    headingAccessory?: React.ReactNode;
  };
  children: React.ReactNode;
}

// v1.17.1 (F-2) — the personalization editors live under the Layout
// hub. They keep their own routes but are NOT standalone nav entries, so
// when the user is on one of them the Layout nav entry is the one that
// reads active.
//
// v1.18.0 (S5) — `mood` (Stimmung) and `medications` (Medikamente)
// graduated to their own nav entries, so they are no longer Layout-hub
// children for highlighting purposes.
const LAYOUT_CHILD_SLUGS: ReadonlySet<string> = new Set([
  "dashboard",
  "insights",
]);

/** Map a Layout child editor onto the Layout hub for nav highlighting. */
function navHighlightSlug(slug: SettingsSectionSlug): SettingsSectionSlug {
  return LAYOUT_CHILD_SLUGS.has(slug) ? "layout" : slug;
}

function deriveActiveSlug(
  pathname: string | null,
  override?: SettingsSectionSlug,
): SettingsSectionSlug {
  if (override) return navHighlightSlug(override);
  if (!pathname) return "account";
  // Match `/settings/<slug>` and ignore any trailing segments (none today,
  // but cheap insurance for future nested routes).
  const match = pathname.match(/^\/settings\/([^/]+)/);
  const candidate = match?.[1] ?? "";
  if (LAYOUT_CHILD_SLUGS.has(candidate)) return "layout";
  return isSettingsSectionSlug(candidate) ? candidate : "account";
}

export function SettingsShell({
  active,
  heading,
  children,
}: SettingsShellProps) {
  const pathname = usePathname();
  const { t } = useTranslations();
  const { user } = useAuth();
  const activeSlug = deriveActiveSlug(pathname, active);

  // v1.18.0 (S5) — per-submodule entries are listed only when their module
  // is enabled. Read from the resolved `useAuth().user.modules` map (the
  // same map the Module hub, nav, and Insights pills gate off). Fail OPEN
  // (`!== false`): a missing key, or a not-yet-resolved `/me` payload,
  // reads as enabled so an entry never silently disappears. Entries with
  // no `moduleGate` (global / CORE) are always shown.
  const modules = user?.modules;
  const visibleSections = SETTINGS_SECTIONS.filter(
    (section) => !section.moduleGate || modules?.[section.moduleGate] !== false,
  );
  const activeSection = visibleSections.find(
    (section) => section.slug === activeSlug,
  );

  // v1.4.33 IW4 — keep the active chip in view inside the horizontal
  // mobile strip. On a 393 CSS px viewport the strip is wider than the
  // viewport and the rightmost chips sit off-screen; a user who tapped
  // one of those chips lands on the new route with the strip still
  // scrolled to the leftmost chip, which reads as if the navigation is
  // broken. We pin the active chip to the left edge of the strip.
  //
  // v1.7.0 — adjust only the strip's own horizontal scroll offset
  // (via `scrollTo({ left })`) instead of `Element.scrollIntoView()`.
  // `scrollIntoView` walks every scrollable ancestor and adjusts both
  // axes, so on mobile it also nudged the whole document vertically on
  // each route change — a dizzy auto-scroll that fired on every settings
  // sub-page tap. Scrolling the strip's own `scrollLeft` confines the
  // motion to its horizontal axis and never touches the page scroll
  // position.
  const mobileStripRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const strip = mobileStripRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    // Land the active chip at the strip's left edge, clamped to the
    // scrollable range. `offsetLeft` is relative to the strip's padding
    // box, which is the origin for `scrollLeft`.
    const maxScroll = strip.scrollWidth - strip.clientWidth;
    const target = Math.max(0, Math.min(active.offsetLeft, maxScroll));
    strip.scrollTo({
      left: target,
      // v1.4.43 W5-H5 — respect `prefers-reduced-motion`.
      behavior: scrollBehaviorForUser(),
    });
  }, [activeSlug]);

  // v1.18.6.1 — resolve the heading once. Pages pass an explicit `heading`
  // (the canonical path); the slug fallback keeps the shell renderable on
  // its own (and in tests that mount it without a heading) by deriving the
  // title from the active section. The heading lives in the shell so it can
  // occupy its own grid row spanning only the content column — see the grid
  // below.
  const resolvedHeading =
    heading ??
    (activeSection
      ? {
          title: t(activeSection.titleKey),
          subtitle: t(`settings.sections.${activeSection.slug}.subtitle`),
          headingId: `settings-section-${activeSection.slug}-title`,
          topSlot: LAYOUT_CHILD_SLUGS.has(activeSection.slug) ? (
            <SettingsHubBackLink
              href="/settings/layout"
              labelKey="settings.sections.layout.backToHub"
            />
          ) : undefined,
          headingAccessory: undefined,
        }
      : null);

  const headingBlock = resolvedHeading ? (
    <div className="space-y-6">
      {resolvedHeading.topSlot ? <div>{resolvedHeading.topSlot}</div> : null}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h1
            id={resolvedHeading.headingId}
            className="text-2xl font-bold tracking-tight"
          >
            {resolvedHeading.title}
          </h1>
          {resolvedHeading.subtitle ? (
            <p className="text-muted-foreground text-sm">
              {resolvedHeading.subtitle}
            </p>
          ) : null}
        </div>
        {resolvedHeading.headingAccessory ? (
          <div className="shrink-0">{resolvedHeading.headingAccessory}</div>
        ) : null}
      </div>
    </div>
  ) : null;

  // v1.4.25 W8 — AuthShell wraps the page in `px-4 py-6 md:px-6`
  // already, so this inner shell only carries the wider max-width.
  // Previously the duplicate `px-4 py-6 md:px-6 md:py-8` here was
  // producing visibly more top/bottom whitespace on Settings/Admin
  // pages than on Dashboard/Insights/Measurements.
  return (
    <div className="mx-auto w-full max-w-screen-xl">
      {/* v1.18.6.1 — on mobile the heading sits above the chip strip; on
          desktop it is rendered inside the grid (row 1 / content column) so
          it does not paint twice. */}
      {headingBlock ? (
        <div className="mb-4 md:hidden">{headingBlock}</div>
      ) : null}

      {/* Mobile section strip — horizontal scroll, hidden on md+.
          `no-scrollbar` (defined in `globals.css`) suppresses the
          painted scrollbar; the horizontal swipe + keyboard arrow
          scrolling still work. Without it the 10-section strip
          renders an always-on scrollbar at the top of every settings
          page, which makes the page feel like every section card has
          an overflow problem.

          v1.4.33 IW7 — `snap-x snap-mandatory` lets a swipe-flick land
          on the next chip's leading edge instead of the in-between
          dead zone. The auto `scrollIntoView({inline: "center"})`
          effect above stays the canonical positioner for the active
          chip; snap is the polish layer when the user manually flicks
          through the strip without tapping. */}
      <nav
        ref={mobileStripRef}
        aria-label={t("settings.shell.sectionsNav")}
        className="no-scrollbar -mx-4 mb-4 snap-x snap-mandatory overflow-x-auto px-4 md:hidden"
      >
        <ul className="flex min-w-max gap-2">
          {visibleSections.map((section) => {
            const isActive = section.slug === activeSlug;
            const Icon = section.icon;
            return (
              <li key={section.slug} className="snap-start">
                <Link
                  href={`/settings/${section.slug}`}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    // v1.4.25 W8 — chip strip is the primary mobile-settings
                    // navigation surface. Pad to WCAG 2.5.5 44 px so the
                    // chips can be tapped without zoom on a Pixel-5.
                    "flex min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                    isActive
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border text-foreground hover:bg-accent",
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {t(section.titleKey)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* v1.18.6.1 — two-row grid on desktop:
            row 1 / col 2 = heading (content column only)
            row 2 / col 1 = nav     row 2 / col 2 = cards
          The nav's first item lines up with the top of the first card BY
          CONSTRUCTION — both start the grid's second row — so the alignment
          holds across locales and however the title or subtitle wraps. No
          fixed-height spacer to guess. The `gap-6` between rows reproduces
          the `space-y-6` the heading-to-first-card gap used to carry. */}
      <div className="grid gap-6 md:grid-cols-[220px_1fr] md:grid-rows-[auto_1fr]">
        {/* Heading — desktop only here (mobile renders it above the strip). */}
        {headingBlock ? (
          <div className="hidden md:col-start-2 md:row-start-1 md:block">
            {headingBlock}
          </div>
        ) : null}

        {/* Desktop sticky sidebar — starts at the cards row (row 2). */}
        <aside
          aria-label={t("settings.shell.sectionsNav")}
          className="hidden md:col-start-1 md:row-start-2 md:block"
        >
          <div className="sticky top-20">
            <ul className="space-y-1">
              {visibleSections.map((section) => {
                const isActive = section.slug === activeSlug;
                const Icon = section.icon;
                return (
                  <li key={section.slug}>
                    <Link
                      href={`/settings/${section.slug}`}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-foreground hover:bg-accent",
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                      {t(section.titleKey)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>

        {/* Main column — page renders its own h1 + subtitle. The
            `min-h-[calc(100dvh-12rem)]` reserve keeps the column tall
            enough that swapping a short loading state for a long
            section list (Thresholds, Sources) does not jump the page
            height under the sticky sidebar.

            v1.4.33 F14 — `pb-24 md:pb-0` reserves a 96 px bottom gutter
            on `<md` so the last form field on
            `/settings/account` (Geschlecht / Gender) and
            `/settings/ai` (Aktiver Provider) is not eaten by the
            floating mobile bottom-nav. Desktop reverts to the parent's
            own padding because the bottom-nav doesn't render on `md+`.

            v1.16.4 — a `<div>`, not `<main>`: the surrounding AuthShell
            already provides the page's single `<main>` landmark and a
            nested second one is an a11y violation. */}
        <div className="min-h-[calc(100dvh-12rem)] min-w-0 pb-24 md:col-start-2 md:row-start-2 md:pb-0">
          {children}
        </div>
      </div>
    </div>
  );
}
