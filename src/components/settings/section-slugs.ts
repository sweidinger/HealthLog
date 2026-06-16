/**
 * Server-safe constants for the v1.4 settings split. Kept in a separate
 * module from `<SettingsShell>` (a client component) so server-rendered code
 * paths — `generateStaticParams()`, the page guard, future tests — can import
 * the slug list without dragging the whole client bundle into the server
 * graph.
 */

// v1.18.0 (S3) — `sources` was folded into Settings → Integrations as the
// "Sources" sub-tab.
// v1.18.1 (D4) — the Integrations sub-tabs (Connections / Channels / Sources)
// were split back into three separate left-side entries: `integrations` (the
// Connections content, shown directly), `channels` (delivery channels), and
// `sources` (source weighting). The `/settings/sources` redirect is gone
// (it is a real route again); `channels` is a brand-new entry.
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
// v1.18.0 (S4) — the standalone `reminders` hub is gone. It was a
// link-only page ("doppelt gemoppelt") that merely deep-linked into the
// canonical editors; reminder TYPES now live centrally in `notifications`,
// each row gated on its module. `/settings/reminders` 301-redirects to
// `/settings/notifications` (next.config.ts).
// v1.18.0 (S5) — per-submodule settings split. `gesundheitsakte` (the full
// health-record export, always available) lifts out of Export & Import into
// its own top-level entry.
export const SETTINGS_SECTION_SLUGS = [
  "account",
  // v1.18.0 — `modules` ("Was du trackst") sits right after account: the
  // single front door for enabling/disabling secondary tracking domains.
  "modules",
  "integrations",
  // v1.18.1 (D4) — Kanäle (delivery channels) + Quellen (source weighting)
  // split out of the Integrations tabs into their own left-side entries.
  "channels",
  "sources",
  "notifications",
  "layout",
  "dashboard",
  "insights",
  "medications",
  "mood",
  "thresholds",
  "ai",
  // v1.18.0 (S5) — `coach` gathers the Coach preference cards (disable
  // toggle, preferences, memory) out of the AI section, module-gated on
  // the coach module. The `ai` entry keeps provider / model / BYOK only.
  "coach",
  "api",
  "gesundheitsakte",
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
