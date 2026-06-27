/**
 * v1.23 — coarse device fingerprinting shared by the active-session list and
 * the new-device sign-in alert.
 *
 * The fingerprint that backs login-alert dedupe is deliberately COARSE and
 * one-way: a SHA-256 over `userId | normalised-User-Agent | coarse-signal`.
 * The raw User-Agent and IP never leave this module into storage — only the
 * salted hash (userId-salted, so the same browser on two accounts hashes
 * differently) and a coarse human-readable label. A minor-version UA bump or a
 * differently-formatted IP must NOT mint a "new device", so the UA is reduced
 * to its family + platform and the geo signal to a country/ASN granularity.
 */
import { createHash } from "node:crypto";

/**
 * Reduce a User-Agent to a stable family + platform descriptor, e.g.
 * "Firefox on macOS". Minor versions, build numbers, and engine noise are
 * dropped so a routine browser update does not register as a new device.
 * Returns "Unknown device" when the UA is missing or unrecognised.
 */
export function coarseDeviceLabel(
  userAgent: string | null | undefined,
): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Unknown device";

  const browser = /\bEdg(?:e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(ua)
      ? "Opera"
      : /\bFirefox\//.test(ua)
        ? "Firefox"
        : /\bChrome\//.test(ua) && !/\bChromium\//.test(ua)
          ? "Chrome"
          : /\bChromium\//.test(ua)
            ? "Chromium"
            : /\bSafari\//.test(ua) && /\bVersion\//.test(ua)
              ? "Safari"
              : /HealthLog-iOS/i.test(ua)
                ? "HealthLog iOS app"
                : null;

  const platform = /\bWindows NT\b/.test(ua)
    ? "Windows"
    : /\b(iPhone|iPad|iPod)\b/.test(ua)
      ? "iOS"
      : /\bMac OS X\b|\bMacintosh\b/.test(ua)
        ? "macOS"
        : /\bAndroid\b/.test(ua)
          ? "Android"
          : /\bLinux\b/.test(ua)
            ? "Linux"
            : null;

  if (browser && platform) return `${browser} on ${platform}`;
  if (browser) return browser;
  if (platform) return platform;
  return "Unknown device";
}

/**
 * Reduce a User-Agent to the stable string fed into the dedupe hash. Uses the
 * coarse label so the hash is invariant to minor-version churn.
 */
export function normaliseUserAgent(
  userAgent: string | null | undefined,
): string {
  return coarseDeviceLabel(userAgent);
}

/**
 * Reduce a resolved geo string to a coarse country-level signal, e.g.
 * "Berlin, DE" → "DE". Falls back to the whole string when there is no
 * trailing country token, and to "" when no location resolved. Kept coarse so
 * a user moving across a city/region does not register as a new device while a
 * cross-country sign-in still does.
 */
export function coarseLocationSignal(
  location: string | null | undefined,
): string {
  const loc = (location ?? "").trim();
  if (!loc) return "";
  const parts = loc.split(",").map((p) => p.trim());
  return parts[parts.length - 1] || loc;
}

/**
 * One-way, per-user device fingerprint. The userId is part of the digest so
 * the same browser on two accounts yields two unrelated hashes (no
 * cross-account correlation), and the raw inputs are never recoverable.
 */
export function computeDeviceHash(params: {
  userId: string;
  userAgent: string | null | undefined;
  coarseSignal: string;
}): string {
  const material = `${params.userId}|${normaliseUserAgent(params.userAgent)}|${params.coarseSignal}`;
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Mask an IP for the user-facing security surfaces: keep enough to recognise
 * the network, drop the host. IPv4 → first two octets; IPv6 → first two
 * hextets. Returns null for a null/blank input.
 */
export function maskIp(ip: string | null | undefined): string | null {
  const raw = (ip ?? "").trim();
  if (!raw) return null;
  if (raw.includes(":")) {
    const groups = raw.split(":").filter((g) => g.length > 0);
    return `${groups.slice(0, 2).join(":")}::`;
  }
  const octets = raw.split(".");
  if (octets.length === 4) {
    return `${octets[0]}.${octets[1]}.x.x`;
  }
  return raw;
}
