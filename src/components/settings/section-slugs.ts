/**
 * Server-safe constants for the v1.4 settings split. Kept in a separate
 * module from `<SettingsShell>` (a client component) so server-rendered code
 * paths — `generateStaticParams()`, the page guard, future tests — can import
 * the slug list without dragging the whole client bundle into the server
 * graph.
 */

// v1.8.7.1 — `thresholds` (Targets) and `sources` (Sources) are again two
// separate settings pages, each its own left-nav entry and route. They were
// merged into one "Targets & Sources" page in v1.4.34 IW-D, but the two
// editors drive distinct mutation flows (`/api/user/thresholds` vs
// `/api/auth/me/source-priority`) and reading them as one page made the
// surface long; splitting them back keeps each concern self-contained.
// Both slugs are served by the dynamic `[section]` route below.
// v1.16.10 — `medications` sits after `insights`: the customise surface
// for the /medications list (view preference + manual order), following
// the dashboard / insights pattern of a dedicated settings section
// reached from the page header's Settings2 glyph.
// v1.17 — `mood` sits after `medications`: the mood-tag management
// surface (groups, custom tags, hide/archive, picker order), reached
// from the /mood page header's wrench glyph.
// v1.17.1 (F-2) — `layout` is the one "Layout & Personalization" home.
// The dashboard / insights / medications / mood personalization editors
// each keep their own route (deep links, page-header cogs, and the hub's
// own links all resolve), but the settings NAV now surfaces a single
// `layout` entry instead of four scattered "arrange" entries, so the
// concept reads as one place. The four editor slugs stay in this list so
// their routes still resolve; they are simply not listed in the shell nav.
// v1.17.1 — `reminders` sits right after `notifications`: the one
// "Reminders & Notifications" home that gathers the scattered reminder
// categories (medication, mood, Vorsorge, low-stock, coach nudge) and links
// to the notification channels. The canonical editors keep their own routes;
// the hub is consolidation by linking.
export const SETTINGS_SECTION_SLUGS = [
  "account",
  "integrations",
  "notifications",
  "reminders",
  "layout",
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
] as const;

export type SettingsSectionSlug = (typeof SETTINGS_SECTION_SLUGS)[number];

export function isSettingsSectionSlug(
  value: string,
): value is SettingsSectionSlug {
  return (SETTINGS_SECTION_SLUGS as readonly string[]).includes(value);
}
