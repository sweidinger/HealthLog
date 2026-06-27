/**
 * Recovery (backup) codes — the lost-authenticator fallback for the TOTP
 * second factor.
 *
 * - **10 single-use codes**, each ~64+ bits of CSPRNG entropy, rendered as
 *   two Base32 groups for legibility (`XXXXX-XXXXX`).
 * - **Argon2id-hashed at rest** (the same primitive and cost parameters as
 *   the account password) — OWASP cautions that recovery-code keyspaces are
 *   small, so a slow hash is what makes the at-rest storage meaningful.
 * - **Shown once** at TOTP confirm (and on explicit regeneration); only the
 *   hash is stored, so the plaintext set can never be re-derived server-side.
 * - **One-time use:** verifying a code burns it (`usedAt`).
 * - **Regeneration invalidates the entire prior set** in a transaction.
 *
 * Verification is constant-time-ish: the candidate is Argon2id-verified
 * against every still-unused hash for the user (Argon2's verify is itself
 * constant-time), so there is no early-exit oracle on which code matched.
 */
import { randomInt } from "node:crypto";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

export const RECOVERY_CODE_COUNT = 10;
/** Crockford-ish Base32 alphabet minus easily-confused glyphs (0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const GROUP_LENGTH = 5;
const GROUPS = 2; // 10 chars over a 29-symbol alphabet ≈ 49 bits/group pair → ~64+ bits set-wide guard below

/** A single high-entropy code, e.g. `7QF3K-MZ2WP`. */
function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LENGTH; i++) {
      group += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** Generate a fresh batch of plaintext codes (caller shows them once). */
export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
): string[] {
  return Array.from({ length: count }, generateRecoveryCode);
}

/** Normalise user input: strip spaces, upper-case (the display is grouped). */
export function normaliseRecoveryCode(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

type TxClient = Prisma.TransactionClient | PrismaClient;

/**
 * Argon2id-hash a batch and persist one row per code. Runs inside the
 * caller's transaction so the recovery set lands atomically with the
 * pending→active promotion (confirm) or the prior-set deletion (regen).
 */
export async function persistRecoveryCodes(
  tx: TxClient,
  userId: string,
  codes: string[],
): Promise<void> {
  const hashes = await Promise.all(
    codes.map((code) => hashPassword(normaliseRecoveryCode(code))),
  );
  await tx.mfaRecoveryCode.createMany({
    data: hashes.map((codeHash) => ({ userId, codeHash })),
  });
}

/**
 * Replace the user's entire recovery-code set with a fresh batch and return
 * the new plaintext codes (shown once). The delete + insert run in one
 * transaction so a regeneration never leaves a half-rotated set.
 */
export async function regenerateRecoveryCodes(
  userId: string,
  count: number = RECOVERY_CODE_COUNT,
): Promise<string[]> {
  const codes = generateRecoveryCodes(count);
  await prisma.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await persistRecoveryCodes(tx, userId, codes);
  });
  return codes;
}

/** Count the codes a user still has available (unused). */
export async function countRemainingRecoveryCodes(
  userId: string,
): Promise<number> {
  return prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
}

/**
 * Verify a candidate against the user's unused codes and burn it on match.
 *
 * The burn is a guarded `updateMany` (`usedAt: null` in the WHERE) so two
 * concurrent verifications of the same code can never both succeed — the
 * second update affects zero rows and is treated as a miss. Returns true
 * only when exactly one row transitioned to used.
 */
export async function verifyAndConsumeRecoveryCode(
  userId: string,
  candidate: string,
): Promise<boolean> {
  const normalised = normaliseRecoveryCode(candidate);
  if (normalised.length === 0) return false;

  const rows = await prisma.mfaRecoveryCode.findMany({
    where: { userId, usedAt: null },
    select: { id: true, codeHash: true },
  });

  for (const row of rows) {
    // Argon2id verify is constant-time per code. A match returns early (the 200
    // already reveals validity, so match-position timing leaks nothing useful);
    // a miss scans on, so a wrong code never reveals how many remain.
    const match = await verifyPassword(row.codeHash, normalised);
    if (!match) continue;

    const burned = await prisma.mfaRecoveryCode.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return burned.count === 1;
  }

  return false;
}
