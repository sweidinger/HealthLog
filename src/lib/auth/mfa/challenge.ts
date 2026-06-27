/**
 * MfaChallenge — the short-lived, single-use login step-up ticket.
 *
 * When a password (or other primary credential) is accepted for an account
 * that has a second factor enabled, **no session or token is issued**.
 * Instead a challenge row is minted: the partial "password OK, awaiting
 * factor 2" state lives entirely in this row, never in a half-built
 * `Session`. The caller receives an opaque ticket; only its hash
 * (`hashToken`) is stored, so a leaked database row cannot reconstruct a
 * usable ticket.
 *
 * Guarantees enforced here:
 * - **TTL** (~5 min) — `expiresAt`; an expired ticket is never loadable.
 * - **Attempt cap** — `attempts` is incremented on every wrong factor and
 *   the ticket is burned (`consumedAt` set) once the cap is hit, forcing a
 *   fresh password login (NIST throttle, not an account lock).
 * - **Claim-once** — consuming a ticket is an atomic guarded update
 *   (`consumedAt: null` in the WHERE), so two concurrent verifications can
 *   never both succeed and mint two sessions. The factor is verified first;
 *   the session is issued only after the claim wins.
 */
import { randomBytes } from "node:crypto";
import { hashToken } from "@/lib/auth/hmac";
import { prisma } from "@/lib/db";

/** Login step-up: the only `kind` Phase M exercises. */
export type MfaChallengeKind = "login";

/** 5-minute ticket life — long enough to read a code, short enough to bound replay. */
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Wrong-factor attempts before the ticket is burned. */
export const MFA_CHALLENGE_ATTEMPT_CAP = 5;

export interface CreatedChallenge {
  /** The opaque ticket handed to the client (never stored in the clear). */
  ticket: string;
  expiresAt: Date;
}

/** Mint a fresh single-use challenge for a user/kind. */
export async function createMfaChallenge(
  userId: string,
  kind: MfaChallengeKind,
): Promise<CreatedChallenge> {
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_MS);
  await prisma.mfaChallenge.create({
    data: {
      userId,
      kind,
      ticketHash: hashToken(ticket),
      expiresAt,
    },
  });
  return { ticket, expiresAt };
}

export interface ActiveChallenge {
  id: string;
  userId: string;
  kind: string;
  attempts: number;
  expiresAt: Date;
}

/**
 * Resolve a presented ticket to its live challenge, or null when it is
 * unknown / already consumed / expired / over the attempt cap. The lookup
 * is by hash — the raw ticket is never compared against a stored plaintext.
 */
export async function loadActiveChallenge(
  ticket: string,
): Promise<ActiveChallenge | null> {
  const row = await prisma.mfaChallenge.findUnique({
    where: { ticketHash: hashToken(ticket) },
    select: {
      id: true,
      userId: true,
      kind: true,
      attempts: true,
      expiresAt: true,
      consumedAt: true,
    },
  });
  if (!row) return null;
  if (row.consumedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (row.attempts >= MFA_CHALLENGE_ATTEMPT_CAP) return null;
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    attempts: row.attempts,
    expiresAt: row.expiresAt,
  };
}

/**
 * Record a failed factor attempt. Increments `attempts`; when the cap is
 * reached the ticket is burned (`consumedAt` set) so it cannot be retried.
 * Returns whether the ticket is now exhausted.
 */
export async function recordChallengeFailure(
  challengeId: string,
): Promise<{ exhausted: boolean; attempts: number }> {
  const updated = await prisma.mfaChallenge.update({
    where: { id: challengeId },
    data: { attempts: { increment: 1 } },
    select: { attempts: true },
  });
  const exhausted = updated.attempts >= MFA_CHALLENGE_ATTEMPT_CAP;
  if (exhausted) {
    await prisma.mfaChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }
  return { exhausted, attempts: updated.attempts };
}

/**
 * Atomically claim the ticket. Returns true only for the single caller that
 * transitions `consumedAt` from null → now. The factor MUST already be
 * verified before this is called; the session is issued only when this
 * returns true.
 */
export async function claimChallenge(challengeId: string): Promise<boolean> {
  const claimed = await prisma.mfaChallenge.updateMany({
    where: { id: challengeId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return claimed.count === 1;
}
