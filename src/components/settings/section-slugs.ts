/**
 * Server-safe constants for the v1.4 settings split. Kept in a separate
 * module from `<SettingsShell>` (a client component) so server-rendered code
 * paths — `generateStaticParams()`, the page guard, future tests — can import
 * the slug list without dragging the whole client bundle into the server
 * graph.
 */

// v1.18.0 (S3) — `sources` is no longer a standalone slug. Source priority
// folded into Settings → Integrations as the "Sources" sub-tab (deciding which
// connection wins when two report the same metric is an Integrations concern).
// `/settings/sources` 301-redirects to `/settings/integrations` (next.config.ts).
// `thresholds` (Targets) keeps its own left-nav entry + route, served by the
// dynamic `[section]` route below.
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
  // v1.18.0 — `modules` ("Was du trackst") sits right after account: the
  // single front door for enabling/disabling secondary tracking domains.
  "modules",
  "integrations",
  "notifications",
  "reminders",
  "layout",
  "dashboard",
  "insights",
  "medications",
  "mood",
  "thresholds",
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
