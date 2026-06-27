/**
 * "Remember this device" — the opt-in trusted-device token that lets a
 * returning browser skip the second factor (factor 2 only) within a 30-day
 * window. The password is ALWAYS still required; a trusted device never
 * replaces factor 1 and is NEVER accepted for step-up (`requireFreshMfa`).
 *
 * Security shape (mirrors the refresh-token / MFA-ticket convention):
 * - The cookie carries a 256-bit random token; only its HMAC hash
 *   (`hashToken`, keyed by `API_TOKEN_HMAC_KEY`) is stored. A leaked
 *   `trusted_devices` row cannot reconstruct a usable cookie.
 * - The cookie is `httpOnly` (a bearer credential JS must never read),
 *   `Secure` (via `shouldEmitSecureCookie`), `SameSite=Strict` (no
 *   cross-site flow depends on it — the login POST is same-origin), bound to
 *   the user via the stored row, and capped at the row's `expiresAt`.
 * - Bound to the user: `consumeTrustedDevice` matches the hash AND the userId,
 *   so one account's cookie can never satisfy another account's login.
 * - Revocable: a single row delete, a per-user wipe (factor removed / sign-out
 *   everywhere), or the `onDelete: Cascade` on account deletion.
 */
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import type { Prisma } from "@/generated/prisma/client";

export const TRUSTED_DEVICE_COOKIE = "hl_trusted_device";
/** 30-day trust window — the ceiling OWASP recommends for a device cookie. */
export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Mint a trusted-device row + set the cookie. Returns the created row id.
 * `label` is a coarse, IP-free device hint for the device list (e.g.
 * "Firefox on macOS"); never store the raw User-Agent or IP here.
 */
export async function mintTrustedDevice(
  userId: string,
  label: string | null,
): Promise<{ id: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_MS);
  const row = await prisma.trustedDevice.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      label,
      expiresAt,
    },
    select: { id: true, expiresAt: true },
  });

  const cookieStore = await cookies();
  cookieStore.set(TRUSTED_DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: shouldEmitSecureCookie(),
    // No cross-site flow depends on this cookie; the login POST is same-origin,
    // so Strict is sent and gives the tightest CSRF posture.
    sameSite: "strict",
    maxAge: Math.floor(TRUSTED_DEVICE_TTL_MS / 1000),
    path: "/",
  });

  return row;
}

/**
 * Resolve the trusted-device cookie against the user being signed in. Returns
 * true only when a live (unexpired) row matches the cookie token's hash AND
 * the userId. Bumps `lastUsedAt` on a hit. An expired row is deleted and
 * treated as a miss; the password step has already happened by the time this
 * is consulted.
 */
export async function consumeTrustedDevice(userId: string): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(TRUSTED_DEVICE_COOKIE)?.value;
  if (!token) return false;

  const row = await prisma.trustedDevice.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, expiresAt: true },
  });
  if (!row || row.userId !== userId) return false;

  if (row.expiresAt.getTime() <= Date.now()) {
    await prisma.trustedDevice
      .deleteMany({ where: { id: row.id } })
      .catch(() => {});
    cookieStore.delete(TRUSTED_DEVICE_COOKIE);
    return false;
  }

  void prisma.trustedDevice
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return true;
}

/** The hash of the caller's current trusted-device cookie, or null. */
export async function currentTrustedDeviceHash(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(TRUSTED_DEVICE_COOKIE)?.value;
  return token ? hashToken(token) : null;
}

export interface TrustedDeviceInfo {
  id: string;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}

/** List the caller's live trusted devices, newest first, current one marked. */
export async function listTrustedDevices(
  userId: string,
): Promise<TrustedDeviceInfo[]> {
  const currentHash = await currentTrustedDeviceHash();
  const rows = await prisma.trustedDevice.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      label: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      tokenHash: true,
    },
    orderBy: { lastUsedAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    expiresAt: r.expiresAt,
    isCurrent: currentHash !== null && r.tokenHash === currentHash,
  }));
}

/**
 * Revoke one trusted device, scoped to the owning user (a foreign id removes
 * nothing). Clears the cookie when the revoked row was the caller's own.
 * Returns whether a row was removed.
 */
export async function revokeTrustedDevice(
  userId: string,
  id: string,
): Promise<boolean> {
  const currentHash = await currentTrustedDeviceHash();
  const row = await prisma.trustedDevice.findFirst({
    where: { id, userId },
    select: { id: true, tokenHash: true },
  });
  if (!row) return false;
  await prisma.trustedDevice.delete({ where: { id: row.id } });
  if (currentHash !== null && row.tokenHash === currentHash) {
    const cookieStore = await cookies();
    cookieStore.delete(TRUSTED_DEVICE_COOKIE);
  }
  return true;
}

/**
 * Revoke EVERY trusted device for a user. Called on a security-state change
 * (second factor removed, sign-out-everywhere, password rotation). Optionally
 * runs inside a caller transaction. Returns the count removed.
 */
export async function revokeAllTrustedDevices(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const client = tx ?? prisma;
  const result = await client.trustedDevice.deleteMany({ where: { userId } });
  return result.count;
}

/** Clear the caller's trusted-device cookie without touching any rows. */
export async function clearTrustedDeviceCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(TRUSTED_DEVICE_COOKIE);
}
