import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

import type {
  EmailChannelConfig,
  NotificationPayload,
} from "@/lib/notifications/types";
import type { SendOutcome } from "@/lib/notifications/retry-policy";
import { getEvent } from "@/lib/logging/context";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";
import { loadEmailConfig } from "@/lib/notifications/senders/email-config";
import { plainPushText } from "@/lib/notifications/strip-emoji";

/**
 * SMTP / email sender (v1.17.1).
 *
 * The SMTP transport is OPERATOR-configured via `SMTP_*` env (see
 * `email-config.ts`); the per-user config carries only the recipient address.
 * When SMTP is unconfigured the send returns a soft `skipped` outcome and the
 * dispatcher never surfaces the channel (the Settings card is hidden too).
 *
 * Body is PLAIN TEXT — no markdown library (hard rule). Routine reminders run
 * through `plainPushText` so the colour-coded phase emoji don't leak into the
 * subject/body; SYSTEM_ALERTs keep their severity glyphs.
 *
 * Transport errors map to a transient `SendOutcome` so the dispatcher's
 * backoff/auto-disable machinery absorbs a flapping mail server exactly like
 * the HTTP channels. nodemailer surfaces `err.responseCode` for SMTP-level
 * rejections; a 5xx permanent rejection (bad recipient, relay denied) is a
 * hard reject so the channel auto-disables rather than retrying forever.
 */

// Cache one transporter per process keyed on the resolved transport config.
// Rebuilding a transporter per send would re-establish the connection pool on
// every dispatch; nodemailer transports are safe to reuse.
let cachedTransporter: Transporter | undefined;
let cachedTransportKey: string | undefined;

function getTransporter(): { transporter: Transporter; from: string } | null {
  const config = loadEmailConfig();
  if (!config) return null;

  const key = JSON.stringify({
    host: config.host,
    port: config.port,
    secure: config.secure,
    hasAuth: Boolean(config.auth),
  });
  if (cachedTransporter && cachedTransportKey === key) {
    return { transporter: cachedTransporter, from: config.from };
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.auth ? { auth: config.auth } : {}),
  });
  cachedTransportKey = key;
  return { transporter: cachedTransporter, from: config.from };
}

/** Test-only: drop the cached transporter so a re-configured env takes effect. */
export function resetEmailTransporterForTesting(): void {
  cachedTransporter = undefined;
  cachedTransportKey = undefined;
}

function classifySmtpError(err: unknown): {
  hardReject: boolean;
  reason: string;
  message: string;
} {
  const message = err instanceof Error ? err.message : "smtp_send_failed";
  // nodemailer attaches `responseCode` (the SMTP reply code) on protocol-level
  // rejections. 5xx = permanent (bad mailbox, relay denied) → hard reject so
  // the channel auto-disables. 4xx / connection errors = transient → retry.
  const responseCode =
    typeof err === "object" && err !== null && "responseCode" in err
      ? (err as { responseCode?: number }).responseCode
      : undefined;
  if (typeof responseCode === "number" && responseCode >= 500) {
    return { hardReject: true, reason: "email_smtp_5xx", message };
  }
  return { hardReject: false, reason: "email_smtp_error", message };
}

export async function sendViaEmail(
  config: EmailChannelConfig,
  payload: NotificationPayload,
): Promise<SendOutcome> {
  const start = performance.now();

  const transport = getTransporter();
  if (!transport) {
    // Operator hasn't configured SMTP — soft skip, no channel burn.
    recordPushAttempt({
      userId: payload.userId,
      channel: "EMAIL",
      eventType: payload.eventType,
      result: "skipped",
      reason: "email_not_configured",
    });
    return { ok: false, hardReject: false, reason: "email_not_configured" };
  }

  if (!config.recipient) {
    recordPushAttempt({
      userId: payload.userId,
      channel: "EMAIL",
      eventType: payload.eventType,
      result: "skipped",
      reason: "email_no_recipient",
    });
    return { ok: false, hardReject: false, reason: "email_no_recipient" };
  }

  // Plain text only — strip HTML + decorative emoji on routine reminders.
  const subject = plainPushText(payload.title, payload.eventType);
  const text = plainPushText(
    payload.message.replace(/<[^>]*>/g, ""),
    payload.eventType,
  );

  try {
    await transport.transporter.sendMail({
      from: transport.from,
      to: config.recipient,
      subject,
      text,
    });

    getEvent()?.addExternalCall({
      service: "email",
      method: "sendMail",
      duration_ms: Math.round(performance.now() - start),
    });
    recordPushAttempt({
      userId: payload.userId,
      channel: "EMAIL",
      eventType: payload.eventType,
      result: "ok",
    });
    return { ok: true };
  } catch (err) {
    const classified = classifySmtpError(err);
    getEvent()?.addExternalCall({
      service: "email",
      method: "sendMail",
      duration_ms: Math.round(performance.now() - start),
      error: classified.message,
    });
    recordPushAttempt({
      userId: payload.userId,
      channel: "EMAIL",
      eventType: payload.eventType,
      result: "error",
      reason: classified.reason,
    });
    return {
      ok: false,
      hardReject: classified.hardReject,
      reason: classified.reason,
      message: classified.message,
    };
  }
}
