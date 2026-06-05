/**
 * v1.12.2 — one-time, Bearer-mintable WHOOP connect ticket.
 *
 * A purely Bearer-authenticated native client (no web-session cookie) cannot
 * start the WHOOP OAuth handshake through `GET /api/whoop/connect` directly,
 * because that route resolves the user from the session cookie. The ticket
 * bridges that gap: the client mints one via an authenticated Bearer
 * `POST /api/whoop/connect/ticket`, then opens
 * `GET /api/whoop/connect?ticket=<opaque>` in an in-app web session. The
 * connect route resolves the user from the unconsumed/unexpired ticket IN LIEU
 * of a cookie, marks it consumed, sets the nonce cookie, and 302s to WHOOP.
 *
 * Security shape (mirrors the Bearer-token storage pattern in
 * `src/lib/auth/hmac.ts`):
 *   - The raw ticket is 32 random bytes → base64url; opaque, 256 bits.
 *   - Only its HMAC-SHA256 hash (keyed by `API_TOKEN_HMAC_KEY`) is persisted —
 *     a DB read cannot recover a usable ticket.
 *   - Single-use: consumption is an atomic conditional `updateMany` predicated
 *     on `consumedAt IS NULL` + `expiresAt > now()`; a `count` of 0 means the
 *     ticket was already consumed, expired, or never existed (all rejected).
 *   - Short-lived (~60s TTL).
 */
import { randomBytes } from "node:crypto";
import { hashToken } from "@/lib/auth/hmac";
import { prisma } from "@/lib/db";

/** 60-second TTL: long enough to hand off into the in-app web session, short
 *  enough that an intercepted ticket is near-useless. */
export const WHOOP_CONNECT_TICKET_TTL_MS = 60 * 1000;

/** Opaque raw ticket: 32 random bytes → 43 base64url chars (256 bits). */
function mintRawTicket(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Mint and persist a single-use connect ticket for `userId`. Returns the raw
 * opaque ticket exactly once; only its hash is stored. Caller is responsible
 * for having authenticated the user (Bearer `requireAuth`).
 */
export async function mintWhoopConnectTicket(userId: string): Promise<string> {
  const raw = mintRawTicket();
  await prisma.whoopConnectTicket.create({
    data: {
      userId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + WHOOP_CONNECT_TICKET_TTL_MS),
    },
  });
  return raw;
}

/**
 * Atomically consume a connect ticket. Resolves the owning `userId` only when
 * the ticket exists, is unexpired, AND was not previously consumed — and in
 * that same operation stamps `consumedAt`, so a concurrent or later second
 * presentation of the same raw ticket finds zero matching rows and is
 * rejected. Returns `null` for any invalid / expired / already-consumed
 * ticket (the caller maps `null` to a typed 401).
 */
export async function consumeWhoopConnectTicket(
  rawTicket: string,
): Promise<{ userId: string } | null> {
  const tokenHash = hashToken(rawTicket);
  const now = new Date();

  // Single-statement atomic consume: the WHERE pins the still-usable
  // predicate, so two racers can't both flip the same row. `updateMany`
  // returns the affected count; 1 = we won, 0 = unusable.
  const consumed = await prisma.whoopConnectTicket.updateMany({
    where: {
      tokenHash,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });

  if (consumed.count !== 1) return null;

  // Re-read to recover the owning user. The row is now consumed; this read
  // only resolves the userId for the connect handshake.
  const row = await prisma.whoopConnectTicket.findUnique({
    where: { tokenHash },
    select: { userId: true },
  });
  return row ? { userId: row.userId } : null;
}
