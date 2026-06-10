/**
 * v1.15.20 — registration invite tokens.
 *
 * When the operator has disabled open registration
 * (`AppSettings.registrationEnabled = false`), an admin can mint an
 * invite link that still admits a signup. The raw token (`hlv_<hex>`)
 * is shown exactly once at mint time; only its HMAC-SHA256 hash under
 * `API_TOKEN_HMAC_KEY` is persisted — the exact `ApiToken` /
 * `ClinicianShareLink` scheme, so a database leak never yields a
 * usable invite. The keyed hash also makes the `tokenHash` unique-index
 * lookup the timing-safe comparison: an attacker without the HMAC key
 * cannot construct hash preimages to probe byte-by-byte.
 *
 * Consumption is an atomic guarded increment (`uses < maxUses` inside
 * the UPDATE's WHERE) so two concurrent signups can never overshoot
 * the budget.
 */
import { randomBytes } from "node:crypto";

import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";

export { INVITE_MAX_TTL_DAYS } from "@/lib/validations/invite";

/** Raw-token prefix — distinct from `hlk_` (API) and `hlr_` (refresh). */
export const INVITE_TOKEN_PREFIX = "hlv_";

/** Generate a fresh raw invite token. 32 random bytes → 64 hex chars. */
export function generateInviteToken(): string {
  return `${INVITE_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

/** Cheap shape gate before paying the HMAC + DB lookup. */
export function looksLikeInviteToken(value: string): boolean {
  return /^hlv_[0-9a-f]{64}$/.test(value);
}

/**
 * Compose the registration deep link for a freshly minted invite.
 * Origin precedence mirrors the passkey RP-origin resolution: the
 * operator-configured `APP_URL` / `NEXT_PUBLIC_APP_URL` win over the
 * request origin (which may be an internal hostname behind the proxy).
 */
export function buildInviteUrl(rawToken: string, requestUrl: string): string {
  const candidates = [
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    requestUrl,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  let origin = "http://localhost:3000";
  for (const candidate of candidates) {
    try {
      origin = new URL(candidate).origin;
      break;
    } catch {
      // try the next candidate
    }
  }
  return `${origin}/auth/register?invite=${encodeURIComponent(rawToken)}`;
}

export type InviteConsumeResult =
  | { ok: true; inviteId: string }
  | {
      ok: false;
      reason: "not_found" | "expired" | "exhausted";
    };

/**
 * Validate + consume one use of an invite token, atomically. Returns the
 * invite id on success so the caller can stamp `usedBy` once the new
 * account exists. The guarded `updateMany` is the only mutation path —
 * `uses < maxUses` inside the WHERE makes the increment race-safe.
 */
export async function consumeInviteToken(
  rawToken: string,
): Promise<InviteConsumeResult> {
  if (!looksLikeInviteToken(rawToken)) {
    return { ok: false, reason: "not_found" };
  }

  const tokenHash = hashToken(rawToken);
  const invite = await prisma.inviteToken.findUnique({
    where: { tokenHash },
    select: { id: true, expiresAt: true, uses: true, maxUses: true },
  });
  if (!invite) return { ok: false, reason: "not_found" };

  const now = new Date();
  if (invite.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  if (invite.uses >= invite.maxUses) {
    return { ok: false, reason: "exhausted" };
  }

  const { count } = await prisma.inviteToken.updateMany({
    where: {
      id: invite.id,
      expiresAt: { gt: now },
      // Guarded increment — Postgres evaluates the predicate and the
      // UPDATE atomically, so a concurrent consumer of the last use
      // makes this a no-op instead of an overshoot.
      uses: { lt: invite.maxUses },
    },
    data: {
      uses: { increment: 1 },
      usedAt: now,
    },
  });
  if (count === 0) {
    return { ok: false, reason: "exhausted" };
  }

  return { ok: true, inviteId: invite.id };
}

/**
 * Stamp the consumer account onto the invite after the user row exists.
 * Best-effort + last-consumer-wins on multi-use invites; a failure here
 * never unwinds the registration.
 */
export async function recordInviteConsumer(
  inviteId: string,
  userId: string,
): Promise<void> {
  try {
    await prisma.inviteToken.update({
      where: { id: inviteId },
      data: { usedBy: userId },
    });
  } catch {
    // Informational column only — the use itself is already counted.
  }
}
