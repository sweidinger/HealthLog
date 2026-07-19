/**
 * Refresh-token issuance + rotation (v1.4 G4).
 *
 * One-time-use semantics: every successful refresh marks the consumed
 * row's `usedAt`, sets `replacedById` to the new row, and revokes the
 * paired access token. Reuse of an already-consumed token is treated as
 * a stolen-token signal and revokes the entire token family (caller must
 * log in again).
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";
import { issueApiToken } from "@/lib/auth/issue-token";
import type { TokenPolicyDecision } from "@/lib/auth/native-client";

export interface IssuedRefreshBundle {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface IssueRefreshOpts {
  userId: string;
  policy: TokenPolicyDecision;
  deviceId?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
  /** Token name suffix for the underlying ApiToken row. */
  source: string;
}

function generateRefreshTokenSecret(): string {
  return `hlr_${randomBytes(32).toString("hex")}`;
}

/**
 * Issue a fresh access token + refresh token pair. Used by:
 *   - login (password + passkey verify) for native callers
 *   - the /api/auth/refresh rotation endpoint
 */
export async function issueAccessAndRefresh(
  opts: IssueRefreshOpts,
): Promise<IssuedRefreshBundle> {
  if (opts.policy.refreshTokenDays === null) {
    throw new Error(
      "issueAccessAndRefresh called for web policy (no refresh token)",
    );
  }

  const access = await issueApiToken({
    userId: opts.userId,
    name: `${opts.policy.tokenLabel} ${opts.source} ${new Date().toISOString()}`,
    permissions: ["*"],
    expiresInDays: opts.policy.accessTokenDays,
  });

  const refresh = generateRefreshTokenSecret();
  const refreshHash = hashToken(refresh);
  const accessTokenHash = hashToken(access.token);
  const expiresAt = new Date(
    Date.now() + opts.policy.refreshTokenDays * 24 * 60 * 60 * 1000,
  );

  await prisma.refreshToken.create({
    data: {
      userId: opts.userId,
      tokenHash: refreshHash,
      accessTokenHash,
      deviceId: opts.deviceId ?? null,
      expiresAt,
      userAgent: opts.userAgent ?? null,
      ipAddress: opts.ipAddress ?? null,
    },
  });

  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh,
    refreshTokenExpiresAt: expiresAt,
  };
}

export type RotationFailureReason =
  "not_found" | "expired" | "already_used" | "revoked" | "device_mismatch";

export type RotationResult =
  | { ok: true; bundle: IssuedRefreshBundle }
  | { ok: false; reason: RotationFailureReason };

/**
 * Atomically rotate a refresh token: validate, mark consumed, issue a new
 * pair, revoke the previously-paired access token. Reuse of a consumed
 * token revokes the whole family (defence against stolen refresh tokens).
 */
export async function rotateRefreshToken(input: {
  refreshToken: string;
  policy: TokenPolicyDecision;
  deviceId?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}): Promise<RotationResult> {
  const hash = hashToken(input.refreshToken);
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: hash },
  });

  if (!row) return { ok: false, reason: "not_found" };
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (row.expiresAt.getTime() <= Date.now())
    return { ok: false, reason: "expired" };

  if (row.usedAt) {
    // Reuse-detection: a previously-consumed refresh token shouldn't be
    // presented again. v1.4.23 scopes the blast radius to the originating
    // device so the legitimate two-device case keeps working — an iPhone
    // dropping into airplane mode shouldn't sign the user out of their
    // iPad. Tokens issued before v1.4.23 (deviceId === null) still
    // revoke-user-wide because we can't isolate them safely.
    //
    // Defence-in-depth note: the iOS client always sends X-Device-Id on
    // refresh, so the legitimate path always carries a deviceId. A
    // missing deviceId on a replay is itself a suspicious signal, hence
    // the fall-through to the wider revoke.
    //
    // M-4 hardening: a legitimate device never changes its id mid-family.
    // If the *presented* deviceId is present but differs from the stored
    // row's deviceId, the device-scoped key is client-asserted and would
    // confine the revoke to the attacker's own fabricated id, leaving the
    // victim's family live. Escalate to the user-wide revoke in that case
    // so a stolen token replayed under a spoofed id can't dodge
    // containment.
    const presentedDeviceId = input.deviceId ?? null;
    const storedDeviceId = row.deviceId ?? null;
    const deviceMismatch =
      presentedDeviceId !== null &&
      storedDeviceId !== null &&
      presentedDeviceId !== storedDeviceId;
    const where: { userId: string; revokedAt: null; deviceId?: string } =
      storedDeviceId !== null && !deviceMismatch
        ? { userId: row.userId, revokedAt: null, deviceId: storedDeviceId }
        : { userId: row.userId, revokedAt: null };
    const compromised = await prisma.refreshToken.findMany({ where });
    await prisma.refreshToken.updateMany({
      where,
      data: { revokedAt: new Date() },
    });
    const accessHashes = compromised
      .map((c) => c.accessTokenHash)
      .filter((v): v is string => Boolean(v));
    if (accessHashes.length > 0) {
      await prisma.apiToken.updateMany({
        where: { tokenHash: { in: accessHashes } },
        data: { revoked: true },
      });
    }
    return { ok: false, reason: "already_used" };
  }

  // A live token belongs to the device it was issued to. The M-4 escalation
  // above already treats a mismatched deviceId on a REPLAY as a spoofing
  // signal; the same mismatch on a still-live token is refused outright
  // rather than silently rotated. Without this the reuse-detection scope is
  // only as honest as the caller: a thief could rotate a stolen token under
  // their own fabricated device id, and the resulting family — keyed on the
  // attacker's id, because `issueAccessAndRefresh` below inherits
  // `row.deviceId ?? input.deviceId` — would sit outside the victim device's
  // containment blast radius.
  //
  // Both ids must be present to compare. A stored null means the row predates
  // per-device issuance and cannot be attributed; a presented null means the
  // caller sent no `X-Device-Id` header. Neither is treated as a mismatch, so
  // this cannot lock out an older client that never sends the header.
  const presentedId = input.deviceId ?? null;
  const storedId = row.deviceId ?? null;
  if (presentedId !== null && storedId !== null && presentedId !== storedId) {
    return { ok: false, reason: "device_mismatch" };
  }

  // Issue the new pair first, THEN mark old consumed in a transaction.
  // (Race: if two concurrent refreshes hit the same row, both will try to
  // mark `usedAt`. We use updateMany with a `usedAt: null` guard so only
  // one wins; the loser's new token row is orphaned but harmless because
  // the loser's access token will be revoked alongside it.)
  const bundle = await issueAccessAndRefresh({
    userId: row.userId,
    policy: input.policy,
    deviceId: row.deviceId ?? input.deviceId ?? null,
    userAgent: input.userAgent ?? row.userAgent,
    ipAddress: input.ipAddress ?? row.ipAddress,
    source: "refresh",
  });

  // Find the row we just created so we can store its id as replacedById.
  const newHash = hashToken(bundle.refreshToken);
  const newRow = await prisma.refreshToken.findUnique({
    where: { tokenHash: newHash },
    select: { id: true },
  });

  const updated = await prisma.refreshToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: {
      usedAt: new Date(),
      replacedById: newRow?.id ?? null,
    },
  });

  if (updated.count === 0) {
    // Lost the race — another concurrent refresh consumed this row.
    // Revoke our just-issued tokens to avoid leaking an extra valid pair.
    await prisma.refreshToken.updateMany({
      where: { tokenHash: newHash },
      data: { revokedAt: new Date() },
    });
    await prisma.apiToken.updateMany({
      where: { tokenHash: hashToken(bundle.accessToken) },
      data: { revoked: true },
    });
    return { ok: false, reason: "already_used" };
  }

  // Best-effort: revoke the access token paired with the consumed refresh,
  // so any leaked access token can't outlive its refresh-token sibling.
  if (row.accessTokenHash) {
    await prisma.apiToken.updateMany({
      where: { tokenHash: row.accessTokenHash, revoked: false },
      data: { revoked: true },
    });
  }

  return { ok: true, bundle };
}

/**
 * Revoke a bearer access token presented at logout (M-2 hardening).
 *
 * `destroySession()` only clears the cookie; for a native/bearer transport
 * that does not round-trip the refresh endpoint, `/api/auth/logout` would
 * otherwise leave the access token valid until expiry. This hashes the raw
 * `hlk_<…>` token, flips the matching `ApiToken.revoked = true`, and
 * revokes its paired `RefreshToken` sibling (matched by `accessTokenHash`)
 * so the whole credential pair dies with the logout.
 *
 * Returns true when a matching live ApiToken row was revoked.
 */
export async function revokeBearerAccessToken(
  rawAccessToken: string,
): Promise<boolean> {
  const accessHash = hashToken(rawAccessToken);

  const apiResult = await prisma.apiToken.updateMany({
    where: { tokenHash: accessHash, revoked: false },
    data: { revoked: true },
  });

  // Revoke the paired refresh sibling so a native logout kills both halves
  // of the pair, mirroring the rotation-time access-token revoke.
  await prisma.refreshToken.updateMany({
    where: { accessTokenHash: accessHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return apiResult.count > 0;
}

/**
 * Revoke a refresh token identified by its stored hash (not the raw secret).
 *
 * Replay-containment reach-back for the native OIDC handoff: the handoff row
 * records only `hashToken(refreshToken)` of the pair it issued, never the raw
 * token, so a replay must revoke by hash. Same effect as `revokeRefreshToken`
 * — flip the refresh row and its paired access token — keyed by the hash the
 * caller already holds.
 *
 * Returns true when a live refresh row was revoked.
 */
export async function revokeRefreshTokenByHash(
  refreshTokenHash: string,
): Promise<boolean> {
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: refreshTokenHash },
    select: { accessTokenHash: true, revokedAt: true },
  });
  if (!row || row.revokedAt) return false;

  const result = await prisma.refreshToken.updateMany({
    where: { tokenHash: refreshTokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) return false;

  if (row.accessTokenHash) {
    await prisma.apiToken.updateMany({
      where: { tokenHash: row.accessTokenHash, revoked: false },
      data: { revoked: true },
    });
  }
  return true;
}

/** Revoke a specific refresh token (logout-on-device).
 *  Also revokes the paired access token so a leaked access token cannot
 *  outlive the refresh-token sibling that the user just killed. */
export async function revokeRefreshToken(
  refreshToken: string,
): Promise<boolean> {
  const hash = hashToken(refreshToken);
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: hash },
    select: { accessTokenHash: true, revokedAt: true },
  });
  if (!row || row.revokedAt) return false;

  const result = await prisma.refreshToken.updateMany({
    where: { tokenHash: hash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (result.count === 0) return false;

  if (row.accessTokenHash) {
    await prisma.apiToken.updateMany({
      where: { tokenHash: row.accessTokenHash, revoked: false },
      data: { revoked: true },
    });
  }
  return true;
}
