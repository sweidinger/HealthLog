/**
 * v1.17.0 (F4) — per-user Oura token accessors.
 * v1.17.1 — per-user BYO client id/secret resolver (DB-first then env).
 *
 * Like WHOOP / Fitbit, Oura is now a per-user BYO-key integration: each user may
 * register their own Oura app and store the client id/secret encrypted on
 * `User`, with a fall-back to the shared env app for existing single-app
 * deploys. Also per-user is the granted access + refresh token. The schema
 * carries NO token-expiry column, so the sync layer refreshes REACTIVELY on a
 * 401 rather than proactively on an expiry timestamp (persisting both rotated
 * tokens).
 */
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { getOuraCredentials, type OuraCredentials } from "./client";

/**
 * Resolve the user's Oura OAuth client id/secret, DB-first then env.
 *
 * v1.17.1 makes Oura a per-user BYO-key integration (mirroring WHOOP / Fitbit):
 * a self-hoster registers their own Oura app and pastes the client id/secret
 * into Settings, stored encrypted on `User`. When the user has not configured
 * per-user keys we fall back to the shared env app (`OURA_CLIENT_ID` /
 * `OURA_CLIENT_SECRET`) so existing single-app deploys keep working. Returns
 * null when neither source is configured.
 */
export async function getOuraClientCredentials(
  userId: string,
): Promise<OuraCredentials | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ouraClientIdEncrypted: true,
      ouraClientSecretEncrypted: true,
    },
  });

  if (user?.ouraClientIdEncrypted && user?.ouraClientSecretEncrypted) {
    return {
      clientId: decrypt(user.ouraClientIdEncrypted),
      clientSecret: decrypt(user.ouraClientSecretEncrypted),
    };
  }

  // Fall back to the shared env-configured OAuth app.
  return getOuraCredentials();
}

/** Persist the user's Oura OAuth client id/secret, encrypted at rest. */
export async function storeOuraClientCredentials(
  userId: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      ouraClientIdEncrypted: encrypt(clientId),
      ouraClientSecretEncrypted: encrypt(clientSecret),
    },
  });
}

/** Clear the user's stored Oura OAuth client id/secret. */
export async function clearOuraClientCredentials(
  userId: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      ouraClientIdEncrypted: null,
      ouraClientSecretEncrypted: null,
    },
  });
}

export interface OuraConnection {
  accessToken: string;
  refreshToken: string;
}

export async function getOuraConnection(
  userId: string,
): Promise<OuraConnection | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ouraAccessTokenEncrypted: true,
      ouraRefreshTokenEncrypted: true,
    },
  });
  if (!user?.ouraAccessTokenEncrypted || !user?.ouraRefreshTokenEncrypted) {
    return null;
  }
  return {
    accessToken: decrypt(user.ouraAccessTokenEncrypted),
    refreshToken: decrypt(user.ouraRefreshTokenEncrypted),
  };
}

/** Persist a rotated token pair after a successful refresh. */
export async function storeOuraTokens(
  userId: string,
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      ouraAccessTokenEncrypted: encrypt(accessToken),
      ouraRefreshTokenEncrypted: encrypt(refreshToken),
    },
  });
}
