/**
 * Token-bound step-up elevations — the Bearer-transport answer to
 * `Session.mfaVerifiedAt`.
 *
 * WHY THIS EXISTS. Second-factor management (enrol TOTP, confirm it, disable
 * it, rotate recovery codes, add or remove a security key) is gated cookie-only.
 * That gate is correct and stays: a Bearer token is a credential whose
 * provenance the server cannot see — it may have come from an interactive login
 * on the owner's phone, or from a value pasted into a script on a shared
 * machine. Tearing down someone's second factor must not be reachable from the
 * weaker of those two.
 *
 * What was missing was never Bearer ACCESS to those routes. It was a way to
 * express, over a transport that has no session row, "the human holding this
 * device just re-proved a factor". The web writes that as a timestamp on the
 * session; a token client has no session to stamp. An elevation is that proof,
 * made explicit and made disposable.
 *
 * THE PROPERTIES, and why each one is load-bearing:
 *
 *   Minted only against a re-proved factor. Presenting the token alone yields
 *   nothing — that is the entire point. A stolen token gains no more reach than
 *   it had before this module existed.
 *
 *   Bound to one token (`apiTokenId`). An elevation minted by the phone cannot
 *   be redeemed by a second token, not even another of the same user's. Theft of
 *   the elevation in transit is therefore useless without also holding the exact
 *   token it was minted for.
 *
 *   Single-use. Redemption is a conditional UPDATE (see `redeemStepUpElevation`)
 *   so two concurrent redemptions cannot both succeed. One management action per
 *   proof, by construction rather than by convention.
 *
 *   Short-lived. `STEP_UP_ELEVATION_TTL_SECONDS` mirrors the cookie path's
 *   `MFA_STEP_UP_MAX_AGE_SECONDS` exactly, so both transports carry the same
 *   freshness promise and neither is the softer way in.
 *
 *   Stored hashed. Only `hashToken(secret)` reaches the database — the same
 *   posture as ApiToken, RefreshToken, and the session secret. A table dump
 *   yields nothing redeemable, and the raw value exists only in the mint
 *   response and the client's memory.
 *
 * INVALIDATION comes from two directions. A password change calls
 * `revokeStepUpElevations` outright. A revoked or deleted token strands its
 * elevations without any code here running: redemption sits behind Bearer
 * resolution, which refuses a revoked token, and the FK cascades on delete.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";

/**
 * Marks a value as a step-up elevation. Distinct from every other credential
 * prefix in the tree (`hlk_` access, `hlr_` refresh, `hls_` session,
 * `hlh_` OIDC handoff) so a value can never be mistaken for the wrong kind.
 */
const ELEVATION_PREFIX = "hle_";
const ELEVATION_SECRET_BYTES = 32;

/**
 * How long an elevation stays redeemable: five minutes.
 *
 * Chosen to equal `MFA_STEP_UP_MAX_AGE_SECONDS`, the window the cookie path has
 * used for step-up since v1.23, rather than picked independently. Two transports
 * guarding the same actions should not offer two different freshness promises —
 * if they diverged, the looser one would simply become the way in. Five minutes
 * also sits at the tight end of the 5–15 minute band OWASP recommends for
 * re-authentication, which is where destructive actions belong; it is long
 * enough to type a code from an authenticator app and short enough that an
 * elevation captured off a screen or a proxy log is stale before it is useful.
 *
 * A test pins the two constants together so a future edit to one is caught.
 */
export const STEP_UP_ELEVATION_TTL_SECONDS = 5 * 60;

/** Which factor was re-proved. Recorded for audit; never an authorisation input. */
export type StepUpMethod = "password" | "passkey";

export interface MintedElevation {
  /** The raw `hle_<64 hex>` value. Returned once; never persisted, never logged. */
  token: string;
  expiresAt: Date;
}

/**
 * Mint an elevation for `(userId, apiTokenId)` after a factor has been re-proved.
 *
 * The caller is responsible for having verified the factor — this function does
 * not check anything, it records a decision already made. Keep the two adjacent
 * so that stays obvious.
 *
 * Any earlier unconsumed elevation for the same token is deleted first. A fresh
 * proof supersedes an older one, so there is never more than one redeemable
 * elevation per token; that both bounds the table and shrinks the window in
 * which a captured elevation is worth anything.
 */
export async function mintStepUpElevation(opts: {
  userId: string;
  apiTokenId: string;
  method: StepUpMethod;
}): Promise<MintedElevation> {
  const raw = `${ELEVATION_PREFIX}${randomBytes(ELEVATION_SECRET_BYTES).toString("hex")}`;
  const expiresAt = new Date(Date.now() + STEP_UP_ELEVATION_TTL_SECONDS * 1000);

  await prisma.stepUpElevation.deleteMany({
    where: { apiTokenId: opts.apiTokenId, consumedAt: null },
  });

  await prisma.stepUpElevation.create({
    data: {
      userId: opts.userId,
      apiTokenId: opts.apiTokenId,
      tokenHash: hashToken(raw),
      method: opts.method,
      expiresAt,
    },
    select: { id: true },
  });

  // Opportunistic housekeeping — cheap, indexed, and keeps the table from
  // accumulating spent rows without needing a scheduled job for a table that
  // only ever sees a handful of rows per user per year.
  prisma.stepUpElevation
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => {});

  return { token: raw, expiresAt };
}

/** Why a redemption was refused. Audit detail only — never surfaced to a caller. */
export type StepUpRedeemFailure =
  "malformed" | "unknown" | "wrong_token" | "consumed" | "expired";

export type StepUpRedeemResult =
  | { ok: true; method: StepUpMethod }
  | { ok: false; reason: StepUpRedeemFailure };

/**
 * Consume an elevation, or refuse.
 *
 * SINGLE-USE ATOMICITY. The claim is one conditional `UPDATE ... WHERE
 * token_hash = $1 AND user_id = $2 AND api_token_id = $3 AND consumed_at IS NULL
 * AND expires_at > $4` (Prisma's `updateMany`), and the caller proceeds only on
 * `count === 1`. Postgres under READ COMMITTED serialises the two writers on the
 * row lock: the loser re-evaluates the predicate against the winner's committed
 * version, finds `consumed_at` no longer null, and matches zero rows. There is
 * no read-then-write window to lose, which is exactly why the check-then-update
 * shape was not used.
 *
 * Both binding fields are in the predicate rather than checked afterwards, so a
 * mismatched token cannot be claimed and then rejected — it is never claimed at
 * all, and the legitimate holder's elevation survives someone else's attempt.
 */
export async function redeemStepUpElevation(opts: {
  rawToken: string;
  userId: string;
  apiTokenId: string;
}): Promise<StepUpRedeemResult> {
  if (!opts.rawToken.startsWith(ELEVATION_PREFIX)) {
    return { ok: false, reason: "malformed" };
  }

  const tokenHash = hashToken(opts.rawToken);
  const now = new Date();

  const claimed = await prisma.stepUpElevation.updateMany({
    where: {
      tokenHash,
      userId: opts.userId,
      apiTokenId: opts.apiTokenId,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });

  if (claimed.count === 1) {
    const row = await prisma.stepUpElevation.findUnique({
      where: { tokenHash },
      select: { method: true },
    });
    return { ok: true, method: (row?.method as StepUpMethod) ?? "password" };
  }

  // Classify the refusal for the audit row only. The caller returns one generic
  // response for every branch below, so this read tells an operator what
  // happened without telling a prober anything.
  const existing = await prisma.stepUpElevation.findUnique({
    where: { tokenHash },
    select: {
      apiTokenId: true,
      userId: true,
      consumedAt: true,
      expiresAt: true,
    },
  });
  if (!existing) return { ok: false, reason: "unknown" };
  if (
    existing.userId !== opts.userId ||
    existing.apiTokenId !== opts.apiTokenId
  ) {
    return { ok: false, reason: "wrong_token" };
  }
  if (existing.consumedAt) return { ok: false, reason: "consumed" };
  return { ok: false, reason: "expired" };
}

/**
 * Drop every elevation for a user.
 *
 * Called when the account password changes: an elevation is a statement about a
 * credential that no longer exists, so it must not outlive it. Deliberately
 * unconditional over the user's rows — consumed ones go too, since there is no
 * reason to keep them once the anchor moved.
 */
export async function revokeStepUpElevations(userId: string): Promise<void> {
  await prisma.stepUpElevation.deleteMany({ where: { userId } });
}
