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
export const SETTINGS_SECTION_SLUGS = [
  "account",
  "integrations",
  "notifications",
  "dashboard",
  "thresholds",
  "sources",
  "ai",
  "api",
  // v1.11.0 — `sharing` owns clinician share links: a time-boxed, scope-
  // frozen read-only view of the owner's record, optionally a scoped FHIR
  // face. Sits next to `api` (the other "hand a credential out" surface).
  "sharing",
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
