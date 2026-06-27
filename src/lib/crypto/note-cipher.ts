/**
 * Free-text health-note ↔ encrypted-column helpers (v1.23).
 *
 * `MoodEntry.note` and `Measurement.notes` are migrating from plaintext to the
 * AES-256-GCM `Bytes` columns `noteEncrypted` / `notesEncrypted`. These helpers
 * are the single read/write boundary every call site goes through so the
 * encrypt-on-write + prefer-ciphertext-fallback-plaintext contract stays
 * consistent.
 *
 * Storage shape is the shared Bytes codec (`@/lib/ai/coach/bytes-codec`) used
 * by every other free-text encrypted-note column (IllnessDayLog, LabResult,
 * Coach memory) — the `encrypt()` ciphertext string stored UTF-8 as `bytea`.
 *
 * FAIL-CLOSED: `readNote` decrypts a present ciphertext and throws on a bad key
 * id / malformed payload rather than silently returning plaintext — the same
 * posture as the rest of the crypto layer. The plaintext fallback only fires
 * when there is NO ciphertext (a legacy row not yet covered by the backfill).
 */
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";

/**
 * Encrypt a free-text note for the `Bytes` ciphertext column. Returns `null`
 * for a null / undefined / empty value so an absent note stores nothing (and
 * the row reads back as "no note"). Whitespace is preserved verbatim — callers
 * that want trimming trim before calling.
 */
export function encryptNote(
  plaintext: string | null | undefined,
): Uint8Array<ArrayBuffer> | null {
  if (plaintext === null || plaintext === undefined || plaintext.length === 0) {
    return null;
  }
  return encryptToBytes(plaintext);
}

/**
 * Read a free-text note, preferring the encrypted column. Falls back to the
 * legacy plaintext column ONLY when there is no ciphertext (a row the backfill
 * has not yet migrated). A present ciphertext is always decrypted; a bad key
 * id / malformed payload throws (fail-closed) rather than leaking the plaintext
 * fallback.
 */
export function readNote(
  ciphertext: Uint8Array | null | undefined,
  plaintextFallback: string | null | undefined,
): string | null {
  if (ciphertext && ciphertext.byteLength > 0) {
    return decryptFromBytes(ciphertext);
  }
  return plaintextFallback ?? null;
}

/**
 * Shape a measurement row for a response/export: surface the decrypted note on
 * `notes` and strip the raw `notesEncrypted` ciphertext so it never leaves the
 * server. Keeps every other column untouched.
 */
export function shapeMeasurementNotes<
  T extends { notes: string | null; notesEncrypted: Uint8Array | null },
>(row: T): Omit<T, "notesEncrypted"> & { notes: string | null } {
  const { notesEncrypted, ...rest } = row;
  return { ...rest, notes: readNote(notesEncrypted, rest.notes) };
}

/**
 * Shape a mood row for a response/export: surface the decrypted note on `note`
 * and strip the raw `noteEncrypted` ciphertext. Keeps every other column
 * untouched.
 */
export function shapeMoodNote<
  T extends { note: string | null; noteEncrypted: Uint8Array | null },
>(row: T): Omit<T, "noteEncrypted"> & { note: string | null } {
  const { noteEncrypted, ...rest } = row;
  return { ...rest, note: readNote(noteEncrypted, rest.note) };
}
