/**
 * Server-safe constants for the v1.5 admin split. Mirrors the pattern in
 * `src/components/settings/section-slugs.ts` so server-rendered code paths
 * (`generateStaticParams()`, the page guard, route-existence tests) can
 * import the slug list without dragging the `<AdminShell>` client bundle
 * into the server graph.
 *
 * Order is the in-app navigation order — sidebar nav, mobile strip, and
 * `generateStaticParams()` all consume it directly.
 */

export const ADMIN_SECTION_SLUGS = [
  "system-status",
  "general",
  "services",
  "integrations",
  "feedback",
  "reminders",
  "users",
  "api-tokens",
  "login-overview",
  "backups",
  "danger-zone",
] as const;

export type AdminSectionSlug = (typeof ADMIN_SECTION_SLUGS)[number];

export function isAdminSectionSlug(value: string): value is AdminSectionSlug {
  return (ADMIN_SECTION_SLUGS as readonly string[]).includes(value);
}

/**
 * Legacy hash-anchor → new slug mapping. Used by `<StatusCardGrid>` to
 * rewrite hrefs and by `proxy.ts` to handle any server-side legacy URL
 * forms (path-style anchors are redirectable; pure `#fragments` never
 * reach the server, so those are fixed at the call-sites instead).
 */
export const LEGACY_ANCHOR_TO_SLUG: Record<string, AdminSectionSlug> = {
  "section-system-status": "system-status",
  "section-admin-general": "general",
  "section-admin-services": "services",
  "section-admin-umami": "integrations",
  "section-admin-glitchtip": "integrations",
  "section-admin-webpush": "integrations",
  "section-admin-bugreport": "integrations",
  "section-admin-feedback": "feedback",
  "section-admin-reminders": "reminders",
  "section-user-management": "users",
  "section-api-tokens": "api-tokens",
  "section-login-overview": "login-overview",
  "section-danger-zone": "danger-zone",
};
