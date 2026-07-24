/**
 * Shared native-handoff core (iOS #49 + iOS #65).
 *
 * Two flows bridge a browser-context login to the cookie-less native token
 * exchange, and they share this one mint/consume core so the security semantics
 * are derived once, not reimplemented:
 *
 *  - OIDC SSO native leg (`flow = "oidc"`): the web OIDC callback mints the code.
 *  - First-party web-handoff (`flow = "web_login"`): the instance's own web
 *    login page mints the code via `/api/auth/native/complete`, so password
 *    autofill and passkeys run in the self-hoster's real web origin.
 *
 * Security posture (unchanged across both flows):
 *  - The return address is a compiled-in constant per flow — there is no
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
 *  - The `flow` discriminator is bound at mint and CHECKED at consume, so a code
 *    minted by one flow can never be exchanged by the other.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";
import { verifyPkceS256 } from "@/lib/mcp/oauth/pkce";
import { revokeRefreshTokenByHash } from "@/lib/auth/refresh-token";
import { auditLog } from "@/lib/auth/audit";

/**
 * The two native-handoff flows. Written to `OidcNativeHandoff.flow` at mint and
 * verified at consume — a cross-flow redemption resolves to `not_found`.
 */
export type HandoffFlow = "oidc" | "web_login";

/**
 * 90-second handoff TTL. The gap it must cover is OS-level (scheme redirect →
 * app foregrounds → one POST) — sub-second in practice; 90s absorbs a slow
 * radio without holding the interception window open. Expiry is enforced at
 * read; a daily sweep prunes stale rows. Shared by both flows.
 */
export const NATIVE_HANDOFF_TTL_MS = 90_000;

/** Distinct prefix — `hlk_` (access) / `hlr_` (refresh) / `hlac_` (MCP) are taken. */
export const HANDOFF_CODE_PREFIX = "hlh_";

/**
 * The 43-char base64url body of a 32-byte (256-bit) CSPRNG code. The token
 * routes' Zod schema pins `^hlh_[A-Za-z0-9_-]{43}$` so only well-formed codes
 * ever reach the hash lookup.
 */
function generateHandoffCode(): string {
  return `${HANDOFF_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * Build a native callback redirect from a compiled-in constant scheme plus
 * query-escaped params only — nothing the client sends is ever echoed into a
 * `Location` header. Assembled by string (not via `new URL`) so the target is
 * exactly `<scheme>?…` with no scheme-normalisation surprises. Each flow passes
 * its own compile-time `redirectUri`; there is no per-request or per-operator
 * redirect target anywhere.
 */
export function buildHandoffCallbackUrl(
  redirectUri: string,
  params: Record<string, string>,
): string {
  const query = new URLSearchParams(params).toString();
  return `${redirectUri}?${query}`;
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
 * instance that started the flow. `flow` records which flow minted the row and
 * is verified at consume. IP/UA are audit-only (a mobile radio changes address
 * between the browser context and the app's socket, so they are NOT validated
 * at exchange).
 */
export async function mintNativeHandoff(input: {
  userId: string;
  appCodeChallenge: string;
  /** Defaults to `oidc` so the OIDC leg's existing call site is unchanged. */
  flow?: HandoffFlow;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<MintedHandoff> {
  const code = generateHandoffCode();
  const row = await prisma.oidcNativeHandoff.create({
    data: {
      userId: input.userId,
      codeHash: hashToken(code),
      codeChallenge: input.appCodeChallenge,
      flow: input.flow ?? "oidc",
      expiresAt: new Date(Date.now() + NATIVE_HANDOFF_TTL_MS),
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
  | { status: "replayed"; userId: string; revokedIssuedPair: boolean }
  | { status: "expired" }
  | { status: "pkce_mismatch" }
  | { status: "race_lost" };

/**
 * Validate + atomically consume a handoff code.
 *
 * Order: hash-lookup → flow check → replay containment → expiry burn →
 * constant-time PKCE verify (burn on mismatch) → guarded single-use consume.
 *
 * The `expectedFlow` gate is the cross-flow boundary: a row minted by the other
 * flow is treated as `not_found` (the same generic 401 the route emits for an
 * unknown code), so an OIDC code can never be redeemed at the web-login token
 * route and vice versa — structurally, not by observation.
 *
 * The replay branch revokes exactly the pair the first exchange issued (via
 * `issuedRefreshTokenHash`) and audits — the accepted DoS-for-containment trade.
 * A failed PKCE check burns the code so an attacker holding the code but not the
 * verifier also denies themselves retries.
 */
export async function consumeNativeHandoff(
  rawCode: string,
  codeVerifier: string,
  /** Defaults to `oidc` so the OIDC leg's existing 2-arg call site is unchanged. */
  expectedFlow: HandoffFlow = "oidc",
): Promise<ConsumeHandoffResult> {
  const codeHash = hashToken(rawCode);
  const row = await prisma.oidcNativeHandoff.findUnique({
    where: { codeHash },
  });

  if (!row) return { status: "not_found" };

  // Cross-flow boundary. A row minted by the OTHER flow is indistinguishable
  // from an unknown code to the caller — never a distinct signal. A missing
  // `flow` (a legacy row written before the column existed) is an OIDC row.
  if ((row.flow ?? "oidc") !== expectedFlow) {
    return { status: "not_found" };
  }

  // Replay: any presentation of an already-consumed row — regardless of
  // whether the presented verifier matches — is an interception signal.
  // Revoke exactly the pair the first exchange issued and audit; the code
  // itself is already spent, so no further consume is needed.
  if (row.consumedAt !== null) {
    // `issuedRefreshTokenHash` is null only in the sub-millisecond window
    // between the consume and the post-`finishLogin` stamp; a replay there
    // finds no pair to revoke (the legitimate pair stays live — a later replay
    // once stamped triggers containment). Report what actually happened so the
    // wide event never claims a revoke that did not occur.
    let revokedIssuedPair = false;
    if (row.issuedRefreshTokenHash) {
      await revokeRefreshTokenByHash(row.issuedRefreshTokenHash);
      revokedIssuedPair = true;
    }
    // Flow-aware audit action so the two flows stay separable in the ledger.
    await auditLog(
      expectedFlow === "web_login"
        ? "auth.native.handoff_replay"
        : "auth.oidc.native.handoff_replay",
      {
        userId: row.userId,
        ipAddress: row.ipAddress,
      },
    );
    return { status: "replayed", userId: row.userId, revokedIssuedPair };
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
