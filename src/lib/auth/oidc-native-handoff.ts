/**
 * Native OIDC SSO session handoff (iOS#49).
 *
 * The web OIDC flow (`/api/auth/oidc/login` → IdP → `/api/auth/oidc/callback`)
 * ends in a session cookie. The native app is a Bearer-transport client and can
 * never consume a cookie. This module bridges the two: the callback mints a
 * one-time, PKCE-locked handoff code that rides ONLY the custom-scheme redirect
 * back to the app; the app exchanges it at `POST /api/auth/oidc/native/token`
 * for the standard native token bundle.
 *
 * Security posture (design spec §2–§4, §10):
 *  - The return address is a compiled-in constant — there is no
 *    `redirect_uri` parameter, so the open-redirect / scheme-hijack class is
 *    removed by construction, not validated away.
 *  - The raw code (`hlh_<…>`) is 256-bit CSPRNG, hashed at rest with the same
 *    `hashToken` (HMAC-SHA256, `API_TOKEN_HMAC_KEY`) used for Bearer/refresh
 *    tokens — a DB dump reconstructs nothing.
 *  - Single-use via a guarded update (`WHERE consumedAt IS NULL`); a failed
 *    PKCE check also burns the code (no verifier oracle, no retry surface).
 *  - A presentation of an already-consumed code is treated as an interception
 *    signal and revokes exactly the token pair the first exchange issued
 *    (refresh-token reuse-detection reach-back).
 *  - The token pair NEVER rides the redirect URL — only the opaque code (or an
 *    MFA ticket) does.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";
import { verifyPkceS256 } from "@/lib/mcp/oauth/pkce";
import { revokeRefreshTokenByHash } from "@/lib/auth/refresh-token";
import { auditLog } from "@/lib/auth/audit";

/**
 * The ONLY callback target for the native flow. Compiled-in, not operator- or
 * client-supplied — see design spec §2. The `healthlog` scheme is an iOS-app
 * dependency the app must register (iOS-coord §9.2). If the shipped app owns a
 * different scheme, this constant is corrected once before release; it remains
 * a compile-time constant either way.
 */
export const NATIVE_OIDC_REDIRECT_URI = "healthlog://oidc-callback";

/**
 * 90-second handoff TTL. The gap it must cover is OS-level (scheme redirect →
 * app foregrounds → one POST) — sub-second in practice; 90s absorbs a slow
 * radio without holding the interception window open. Expiry is enforced at
 * read; a daily sweep prunes stale rows.
 */
export const OIDC_NATIVE_HANDOFF_TTL_MS = 90_000;

/** Distinct prefix — `hlk_` (access) / `hlr_` (refresh) / `hlac_` (MCP) are taken. */
export const HANDOFF_CODE_PREFIX = "hlh_";

/**
 * The 43-char base64url body of a 32-byte (256-bit) CSPRNG code. The token
 * route's Zod schema pins `^hlh_[A-Za-z0-9_-]{43}$` so only well-formed codes
 * ever reach the hash lookup.
 */
function generateHandoffCode(): string {
  return `${HANDOFF_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * Build the native callback redirect from the compiled-in constant plus
 * query-escaped params only — nothing the client sends is ever echoed into a
 * `Location` header on the native branch. Assembled by string (not via `new
 * URL`) so the target is exactly `healthlog://oidc-callback?…` with no
 * scheme-normalisation surprises.
 */
export function buildNativeCallbackUrl(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${NATIVE_OIDC_REDIRECT_URI}?${query}`;
}

export interface MintedHandoff {
  /** The raw `hlh_<…>` code — placed ONLY on the custom-scheme redirect. */
  code: string;
  handoffId: string;
}

/**
 * Mint a fresh single-use handoff code for a resolved identity. `userId` comes
 * from the server-side identity resolution, never from client input; the app's
 * S256 challenge is bound here so the exchange can prove the caller is the app
 * instance that started the flow. IP/UA are audit-only (a mobile radio changes
 * address between the browser context and the app's socket, so they are NOT
 * validated at exchange).
 */
export async function mintNativeHandoff(input: {
  userId: string;
  appCodeChallenge: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<MintedHandoff> {
  const code = generateHandoffCode();
  const row = await prisma.oidcNativeHandoff.create({
    data: {
      userId: input.userId,
      codeHash: hashToken(code),
      codeChallenge: input.appCodeChallenge,
      expiresAt: new Date(Date.now() + OIDC_NATIVE_HANDOFF_TTL_MS),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    select: { id: true },
  });
  return { code, handoffId: row.id };
}

/**
 * Closed result union for `consumeNativeHandoff`. Every non-`ok` variant maps
 * to the same generic 401 at the route so a code-guesser learns nothing;
 * distinct variants keep the wide events diagnosable.
 */
export type ConsumeHandoffResult =
  | { status: "ok"; userId: string; handoffId: string }
  | { status: "not_found" }
  | { status: "replayed"; userId: string }
  | { status: "expired" }
  | { status: "pkce_mismatch" }
  | { status: "race_lost" };

/**
 * Validate + atomically consume a handoff code (design spec §4 steps 4–8).
 *
 * Order: hash-lookup → replay containment → expiry burn → constant-time PKCE
 * verify (burn on mismatch) → guarded single-use consume. The replay branch
 * revokes exactly the pair the first exchange issued (via
 * `issuedRefreshTokenHash`) and audits — the accepted DoS-for-containment trade
 * (spec §10 T7). A failed PKCE check burns the code so an attacker holding the
 * code but not the verifier also denies themselves retries (spec §10 T1).
 */
export async function consumeNativeHandoff(
  rawCode: string,
  codeVerifier: string,
): Promise<ConsumeHandoffResult> {
  const codeHash = hashToken(rawCode);
  const row = await prisma.oidcNativeHandoff.findUnique({
    where: { codeHash },
  });

  if (!row) return { status: "not_found" };

  // Replay: any presentation of an already-consumed row — regardless of
  // whether the presented verifier matches — is an interception signal.
  // Revoke exactly the pair the first exchange issued and audit; the code
  // itself is already spent, so no further consume is needed.
  if (row.consumedAt !== null) {
    if (row.issuedRefreshTokenHash) {
      await revokeRefreshTokenByHash(row.issuedRefreshTokenHash);
    }
    await auditLog("auth.oidc.native.handoff_replay", {
      userId: row.userId,
      ipAddress: row.ipAddress,
    });
    return { status: "replayed", userId: row.userId };
  }

  // Expiry: enforced at read. Burn the row so a lingering expired code has no
  // second life even before the sweep job reaps it.
  if (row.expiresAt.getTime() <= Date.now()) {
    await burnHandoff(row.id);
    return { status: "expired" };
  }

  // PKCE: constant-time S256. A mismatch burns the code (single-presentation
  // posture) — no verifier oracle.
  if (!verifyPkceS256(codeVerifier, row.codeChallenge)) {
    await burnHandoff(row.id);
    return { status: "pkce_mismatch" };
  }

  // Single-use consume — the same claim-once shape as `claimChallenge` /
  // refresh rotation. Two concurrent exchanges mint at most one bundle.
  const consumed = await prisma.oidcNativeHandoff.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    // Lost the race — the winner's pair is legitimately in flight; do NOT
    // revoke. A genuine later replay is caught by the consumed-at branch above.
    return { status: "race_lost" };
  }

  return { status: "ok", userId: row.userId, handoffId: row.id };
}

/** Guarded burn: consume a live row without issuing anything. */
async function burnHandoff(id: string): Promise<void> {
  await prisma.oidcNativeHandoff.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
}

/**
 * Stamp the hash of the refresh token minted at exchange onto the consumed
 * handoff row, so a later replay can revoke exactly this family member. Called
 * after `finishLogin` succeeds. Best-effort: a failure here never fails the
 * login (the code is already single-use-consumed), it only forgoes the
 * replay-reach-back for this one row.
 */
export async function stampIssuedRefreshToken(
  handoffId: string,
  refreshToken: string,
): Promise<void> {
  await prisma.oidcNativeHandoff.update({
    where: { id: handoffId },
    data: { issuedRefreshTokenHash: hashToken(refreshToken) },
  });
}
