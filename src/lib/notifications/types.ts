/**
 * Notification system type definitions.
 * Channels: Telegram, ntfy, Web Push
 * Events: medication reminders, anomalies, compliance, etc.
 */

export const CHANNEL_TYPES = ["TELEGRAM", "NTFY", "WEB_PUSH", "APNS"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const EVENT_TYPES = [
  "MEDICATION_REMINDER",
  "MEASUREMENT_ANOMALY",
  "COMPLIANCE_LOW",
  "WITHINGS_SYNC_FAILED",
  "SYSTEM_ALERT",
  // v1.4.25 W16c — PR detection. Default OFF (see DEFAULT_EVENT_PREFS
  // below) so a multi-year Apple Health backfill doesn't fire hundreds
  // of pushes during initial sync.
  "PERSONAL_RECORD",
  // v0.5.4 ios-coord — daily mood-reminder nudge. Default OFF on the
  // per-event policy (see DEFAULT_EVENT_PREFS) and additionally gated
  // on the per-user `moodReminderEnabled` flag, so a user has to opt
  // in twice before the server starts nudging them about an
  // emotionally-loaded surface.
  "MOOD_REMINDER",
  // v1.15 — cycle reminders. Both default OFF (see EVENT_DEFAULT_ENABLED)
  // and are gated again on `CycleProfile.cycleTrackingEnabled`, so a user
  // opts in twice before the server nudges about an intent-revealing,
  // privacy-sensitive surface. `CYCLE_PERIOD_SOON` fires a couple of days
  // before the predicted next-period start; `CYCLE_PERIOD_CONFIRM` is a
  // gentle "did your period start?" on/after the predicted start while no
  // period is logged. When `CycleProfile.discreetNotifications` is true the
  // push body is the generic "HealthLog reminder" so no cycle event is
  // named on the lock screen.
  "CYCLE_PERIOD_SOON",
  "CYCLE_PERIOD_CONFIRM",
  // v1.15.1 — fertile-window reminder. Default OFF (see EVENT_DEFAULT_ENABLED)
  // and TTC-gated in the cron: it only fires when `CycleProfile.goal ===
  // "TRYING_TO_CONCEIVE"`, so fertile language never reaches the
  // AVOID_PREGNANCY / GENERAL_HEALTH / PERIMENOPAUSE goals (the inclusive-
  // framing rule). Fires a few days before `CyclePrediction.fertileWindowStart`
  // and honours discreet mode like the other cycle reminders.
  "CYCLE_FERTILE_SOON",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Per-event default policy when no `NotificationPreference` row
 * exists. The dispatcher reads this to decide whether to fire on a
 * channel that has never been explicitly toggled for the event.
 *
 * Every event defaults to ON (the original opt-out model) EXCEPT
 * `PERSONAL_RECORD`: PRs are silent by default and require the user
 * to explicitly enable them in `/settings/notifications`. Rationale —
 * a fresh iOS install backfilling years of HealthKit history would
 * otherwise saturate the user's lock-screen on first launch.
 */
export const EVENT_DEFAULT_ENABLED: Record<EventType, boolean> = {
  MEDICATION_REMINDER: true,
  MEASUREMENT_ANOMALY: true,
  COMPLIANCE_LOW: true,
  WITHINGS_SYNC_FAILED: true,
  SYSTEM_ALERT: true,
  PERSONAL_RECORD: false,
  // v0.5.4 ios-coord — see note above on `EVENT_TYPES`. Default OFF
  // is the safer posture: even if a future surface forgets to gate on
  // `User.moodReminderEnabled`, this per-event default also has to be
  // flipped on before the dispatcher will surface the channel.
  MOOD_REMINDER: false,
  // v1.15 — cycle reminders default OFF. Even if a future surface forgets
  // to gate on `CycleProfile.cycleTrackingEnabled`, this per-event default
  // also has to be flipped on before the dispatcher surfaces the channel.
  CYCLE_PERIOD_SOON: false,
  CYCLE_PERIOD_CONFIRM: false,
  // v1.15.1 — default OFF and additionally TTC-gated in the cron, so the
  // server never surfaces fertile-window language unless the user has both
  // chosen the conception goal and opted the reminder in.
  CYCLE_FERTILE_SOON: false,
};

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  TELEGRAM: "Telegram",
  NTFY: "ntfy",
  WEB_PUSH: "Web Push",
  APNS: "Apple Push (APNs)",
};

// ── Channel config shapes (stored as encrypted JSON) ──

export interface TelegramChannelConfig {
  botToken: string;
  chatId: string;
}

export interface NtfyChannelConfig {
  serverUrl: string;
  topic: string;
  authToken?: string;
}

// ── Notification payload ──

export interface NotificationPayload {
  eventType: EventType;
  userId: string;
  title: string;
  message: string;
  /** Channel-specific extras (e.g. medicationId for Telegram inline buttons) */
  metadata?: Record<string, unknown>;
  /**
   * Discreet mode (cycle privacy). When true, the lock-screen-visible
   * routing metadata the senders would otherwise derive from `eventType`
   * (APNs category / threadId / collapseId, ntfy Tags) is replaced with a
   * generic value so the cycle event name never appears on the lock screen
   * — the title/body are already masked upstream.
   */
  discreet?: boolean;
}
