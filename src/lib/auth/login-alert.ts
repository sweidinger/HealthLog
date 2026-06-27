/**
 * v1.23 — new-device / new-location sign-in alert.
 *
 * Called on every completed sign-in (password, MFA-verify, passkey). Computes
 * a coarse, one-way device fingerprint (see `device-fingerprint.ts`) and:
 *   - first sighting of the fingerprint → record it AND fire one notification
 *     through the dispatcher cascade (respecting the user's per-channel prefs),
 *   - any later sighting → bump `lastSeenAt` only, stay silent (dedupe).
 *
 * The whole thing is best-effort and is invoked fire-and-forget from the login
 * paths: a failure here must never block or fail a sign-in. The raw IP/UA are
 * never persisted — only the salted hash + a coarse label (and the audit row,
 * which already records IP/geo for `auth.*` events).
 */
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { lookupIpLocation, lookupIpAsn } from "@/lib/geo";
import {
  coarseDeviceLabel,
  coarseLocationSignal,
  computeDeviceHash,
} from "@/lib/auth/device-fingerprint";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { getEvent } from "@/lib/logging/context";

function isLocale(value: string | null | undefined): value is Locale {
  return (
    value === "de" ||
    value === "en" ||
    value === "fr" ||
    value === "es" ||
    value === "it" ||
    value === "pl"
  );
}

export interface RecordSignInResult {
  known: boolean;
  alerted: boolean;
}

export async function recordSignInDevice(params: {
  userId: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * When false the device is recorded silently with no notification — used by
   * account registration, where the very first device should not trigger a
   * "new device" alert the moment the account is created.
   */
  alertOnNew?: boolean;
}): Promise<RecordSignInResult> {
  const { userId, ip, userAgent } = params;
  const alertOnNew = params.alertOnNew ?? true;

  try {
    // Coarse geo signal — best-effort. The location resolver is online-first
    // with its own timeout; a miss falls back to the ASN number so a device
    // on the same network still dedupes even without a city.
    let location: string | null = null;
    try {
      location = await lookupIpLocation(ip);
    } catch {
      location = null;
    }
    const coarseSignal =
      coarseLocationSignal(location) || lookupIpAsn(ip)?.asn?.toString() || "";

    const deviceHash = computeDeviceHash({ userId, userAgent, coarseSignal });
    const deviceLabel = coarseDeviceLabel(userAgent);
    const storedLabel = location ? `${deviceLabel} — ${location}` : deviceLabel;

    const existing = await prisma.userKnownDevice.findUnique({
      where: { userId_deviceHash: { userId, deviceHash } },
      select: { id: true },
    });

    if (existing) {
      await prisma.userKnownDevice
        .update({
          where: { id: existing.id },
          data: { lastSeenAt: new Date() },
        })
        .catch(() => {});
      return { known: true, alerted: false };
    }

    // First sighting. Insert; if a concurrent first-login races us to the
    // unique (userId, deviceHash) index, swallow it and treat as already known
    // so we never double-alert.
    try {
      await prisma.userKnownDevice.create({
        data: { userId, deviceHash, label: storedLabel },
      });
    } catch {
      return { known: true, alerted: false };
    }

    if (!alertOnNew) return { known: false, alerted: false };

    await auditLog("auth.login.new_device", {
      userId,
      ipAddress: ip,
      details: { device: deviceLabel },
    });

    // Localise against the recipient's own locale, then fan out through the
    // dispatcher (which applies the user's per-channel SECURITY_ALERT prefs).
    let locale: Locale = defaultLocale;
    try {
      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { locale: true },
      });
      if (isLocale(row?.locale)) locale = row.locale;
    } catch {
      locale = defaultLocale;
    }
    const { t } = getServerTranslator(locale);
    const locationText =
      location ?? t("notifications.security.unknownLocation");

    await dispatchNotification({
      eventType: "SECURITY_ALERT",
      userId,
      title: t("notifications.security.newDeviceTitle"),
      message: t("notifications.security.newDeviceBody", {
        device: deviceLabel,
        location: locationText,
      }),
      urgent: true,
    });

    return { known: false, alerted: true };
  } catch (err) {
    getEvent()?.addWarning(
      `recordSignInDevice failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { known: false, alerted: false };
  }
}
