/**
 * v1.17.0 (F4) — per-user Oura token accessors.
 *
 * Oura uses a single shared OAuth app (env client id/secret via
 * `getOuraCredentials`). Per-user state is the granted access + refresh token,
 * stored encrypted on `User`. The merged schema carries NO token-expiry column,
 * so the sync layer refreshes REACTIVELY on a 401 rather than proactively on an
 * expiry timestamp (and persists both rotated tokens).
 */
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";

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
