import type {
  NtfyChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import { getEvent } from "@/lib/logging/context";

/**
 * Send notification via ntfy (simple HTTP POST).
 * See https://docs.ntfy.sh/publish/
 */
export async function sendViaNtfy(
  config: NtfyChannelConfig,
  payload: NotificationPayload,
): Promise<boolean> {
  const start = performance.now();
  try {
    const url = `${config.serverUrl.replace(/\/$/, "")}/${encodeURIComponent(config.topic)}`;

    const headers: Record<string, string> = {
      Title: payload.title,
      Priority:
        payload.eventType === "MEDICATION_REMINDER" ? "high" : "default",
      Tags: payload.eventType.toLowerCase().replace(/_/g, "-"),
    };

    if (config.authToken) {
      headers["Authorization"] = `Bearer ${config.authToken}`;
    }

    // Strip HTML tags for ntfy (plain text only)
    const body = payload.message.replace(/<[^>]*>/g, "");

    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });

    getEvent()?.addExternalCall({
      service: "ntfy",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      status: res.status,
    });

    return res.ok;
  } catch (err) {
    getEvent()?.addExternalCall({
      service: "ntfy",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : "request_failed",
    });
    return false;
  }
}
