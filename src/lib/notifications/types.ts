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
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  MEDICATION_REMINDER: "Medication reminder",
  MEASUREMENT_ANOMALY: "Anomalous measurements",
  COMPLIANCE_LOW: "Low compliance",
  WITHINGS_SYNC_FAILED: "Withings sync failed",
  SYSTEM_ALERT: "System alerts",
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

export type WebPushChannelConfig = Record<string, never>;

/**
 * APNs channel config is empty by design — the per-device APNs token +
 * environment live on the `Device` model, not on the channel row. The
 * channel row exists so per-event preference toggles in
 * `NotificationPreference` apply uniformly across all four channels.
 */
export type ApnsChannelConfig = Record<string, never>;

export type ChannelConfig =
  | TelegramChannelConfig
  | NtfyChannelConfig
  | WebPushChannelConfig
  | ApnsChannelConfig;

// ── Notification payload ──

export interface NotificationPayload {
  eventType: EventType;
  userId: string;
  title: string;
  message: string;
  /** Channel-specific extras (e.g. medicationId for Telegram inline buttons) */
  metadata?: Record<string, unknown>;
}
