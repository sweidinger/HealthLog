import type {
  NtfyChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { classifyHttpStatus } from "@/lib/notifications/retry-policy";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";
import { safeFetch } from "@/lib/safe-fetch";
import { plainPushText } from "@/lib/notifications/strip-emoji";

/**
 * Send notification via ntfy (simple HTTP POST).
 * See https://docs.ntfy.sh/publish/
 *
 * Returns a structured `SendOutcome` so the dispatcher (v1.4.15 Phase B3)
 * can distinguish hard rejects (HTTP 410, topic deleted) from soft errors
 * (5xx, 429, network timeout) and apply the right retry / auto-disable
 * policy.
 */
export async function sendViaNtfy(
  config: NtfyChannelConfig,
  payload: NotificationPayload,
): Promise<SendOutcome> {
  const start = performance.now();
  try {
    const url = `${config.serverUrl.replace(/\/$/, "")}/${encodeURIComponent(config.topic)}`;

    const headers: Record<string, string> = {
      Title: plainPushText(payload.title, payload.eventType),
      Priority:
        payload.eventType === "MEDICATION_REMINDER" ? "high" : "default",
      // Discreet mode (cycle privacy): the X-Tags header is visible on the
      // lock screen, so collapse it to a generic tag instead of leaking the
      // cycle event name.
      Tags: payload.discreet
        ? "reminder"
        : payload.eventType.toLowerCase().replace(/_/g, "-"),
    };

    if (config.authToken) {
      headers["Authorization"] = `Bearer ${config.authToken}`;
    }

    // Strip HTML tags for ntfy (plain text only) + emoji on routine reminders
    const body = plainPushText(
      payload.message.replace(/<[^>]*>/g, ""),
      payload.eventType,
    );

    // requirePublicHost adds the DNS-rebinding pin (issue #217) on top
    // of the input-time isPublicUrl guard already enforced when the
    // user saved the ntfy serverUrl in their channel config. The
    // authToken would otherwise leak on a rebinding flip to a private
    // address.
    const res = await safeFetch(
      url,
      {
        method: "POST",
        headers,
        body,
      },
      { timeoutMs: 5_000, requirePublicHost: true },
    );

    getEvent()?.addExternalCall({
      service: "ntfy",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      status: res.status,
    });

    if (res.ok) {
      recordPushAttempt({
        userId: payload.userId,
        channel: "NTFY",
        eventType: payload.eventType,
        result: "ok",
      });
      return { ok: true, statusCode: res.status };
    }
    const classified = classifyHttpStatus(res.status, "ntfy");
    recordPushAttempt({
      userId: payload.userId,
      channel: "NTFY",
      eventType: payload.eventType,
      result: "error",
      reason: classified.reason,
    });
    return {
      ok: false,
      statusCode: res.status,
      hardReject: classified.hardReject,
      reason: classified.reason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "request_failed";
    getEvent()?.addExternalCall({
      service: "ntfy",
      method: "sendNotification",
      duration_ms: Math.round(performance.now() - start),
      error: message,
    });
    recordPushAttempt({
      userId: payload.userId,
      channel: "NTFY",
      eventType: payload.eventType,
      result: "error",
      reason: "ntfy_network_error",
    });
    return {
      ok: false,
      hardReject: false,
      reason: "ntfy_network_error",
      message,
    };
  }
}
