/**
 * Query keys — settings + notification surfaces, version/meta reads,
 * gamification, share links, and feature flags.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const settingsKeys = {
  gamificationAchievements: () => ["gamification", "achievements"] as const,

  notificationsPreferences: () => ["notifications", "preferences"] as const,
  notificationsStatus: () => ["notifications", "status"] as const,

  settingsGlobalServices: () => ["settings", "global-services"] as const,
  settingsNtfy: () => ["settings", "ntfy"] as const,
  /** v1.17.1 — generic-webhook channel config. */
  settingsWebhook: () => ["settings", "webhook"] as const,
  /** v1.17.1 — SMTP / email channel config. */
  settingsEmail: () => ["settings", "email"] as const,
  settingsReminderThresholds: () =>
    ["settings", "reminder-thresholds"] as const,

  /** v1.8.5 — user-level injection-site preferences (global exclusion). */
  injectionSitePrefs: () => ["settings", "injection-site-prefs"] as const,

  apiVersion: () => ["api", "version"] as const,
  publicVersion: () => ["public", "version"] as const,
  /** v1.15.12 H1 — admin overview "update available" check against the
   * latest GitHub release tag (best-effort, day-stale). */
  versionUpdateCheck: () => ["version", "update-check"] as const,
  researchMode: () => ["research-mode"] as const,

  /** v1.11.0 — owner's clinician share links (Settings → Sharing). */
  shareLinks: () => ["share-links"] as const,

  featureFlags: () => ["feature-flags"] as const,

  bugreportStatus: () => ["bugreport", "status"] as const,
};
