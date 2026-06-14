/**
 * v1.17.0 (F4) — per-user Polar token accessors.
 *
 * Unlike WHOOP (per-user BYO client id/secret), Polar uses a single shared
 * OAuth app whose client id/secret come from env (`getPolarCredentials`). What
 * is per-user is the granted token + Polar member id, stored encrypted on
 * `User`. Polar access tokens do not expire and carry no refresh token, so
 * there is no refresh path — a revoked grant surfaces as a 401 on the next read.
 */
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

export interface PolarConnection {
  accessToken: string;
  /** Polar numeric member id (`x_user_id`), needed for every data path. */
  polarUserId: string;
}

/**
 * Fetch + decrypt the user's stored Polar token. Returns null when the user has
 * not connected Polar (no access token) or the member id is missing.
 */
export async function getPolarConnection(
  userId: string,
): Promise<PolarConnection | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      polarAccessTokenEncrypted: true,
      polarUserIdEncrypted: true,
    },
  });
  if (!user?.polarAccessTokenEncrypted || !user?.polarUserIdEncrypted) {
    return null;
  }
  return {
    accessToken: decrypt(user.polarAccessTokenEncrypted),
    polarUserId: decrypt(user.polarUserIdEncrypted),
  };
}
