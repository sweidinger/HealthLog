/**
 * v1.17.1 — server-side helpers for the structured lab-result store.
 *
 * Two concerns live here:
 *
 *   1. The AES-256-GCM ↔ `Bytes` codec for `LabResult.noteEncrypted`. The
 *      free-text note is the only sensitive column on the model; it shares
 *      the `encrypt()` string format (`"<keyId>.<base64>"`) every other
 *      `*Encrypted` column uses, encoded as UTF-8 bytes.
 *
 *   2. `findLatestLabResultForAnalytes` — the read point the Vorsorge
 *      annual-blood-panel reminder consults to decide whether a panel was
 *      recorded inside its lead-time window. Exposed here, NOT coupled to
 *      the reminder's code, so the reminder can mark itself satisfied
 *      without this module taking a dependency on it.
 */
import { Buffer } from "node:buffer";

import { decrypt, encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";

/** Encrypt a UTF-8 note into the `Bytes` payload the schema stores. */
export function encryptNoteToBytes(plaintext: string): Uint8Array<ArrayBuffer> {
  const ciphertext = encrypt(plaintext);
  const encoded = Buffer.from(ciphertext, "utf8");
  // Prisma `Bytes` maps to `Uint8Array<ArrayBuffer>`; allocate a fresh
  // ArrayBuffer-backed view so the structural type stays stable.
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

/** Decrypt a stored `Bytes` note back to plaintext. Throws on a bad key id. */
export function decryptNoteFromBytes(buf: Uint8Array): string {
  return decrypt(Buffer.from(buf).toString("utf8"));
}

/**
 * Latest live (non-tombstoned) lab result for any of the given analytes,
 * recorded at or after `since`. Returns the single most-recent matching
 * row by `takenAt`, or `null` when no matching result exists in the window.
 *
 * Case-insensitive analyte match so "HbA1c" / "hba1c" resolve the same — a
 * lab report's casing is not the user's concern. The Vorsorge reminder
 * passes the analytes that satisfy an annual blood panel (e.g. an HbA1c or
 * a lipid marker) plus the reminder's window start; a non-null return means
 * the panel was recorded and the reminder can mark itself satisfied.
 */
export async function findLatestLabResultForAnalytes(
  userId: string,
  analytes: string[],
  since: Date,
): Promise<{ id: string; analyte: string; takenAt: Date } | null> {
  if (analytes.length === 0) return null;
  const candidates = await prisma.labResult.findMany({
    where: {
      userId,
      deletedAt: null,
      takenAt: { gte: since },
      // Prisma has no case-insensitive `in`; match each analyte
      // case-insensitively and let the DB OR them together.
      OR: analytes.map((a) => ({
        analyte: { equals: a, mode: "insensitive" as const },
      })),
    },
    orderBy: { takenAt: "desc" },
    take: 1,
    select: { id: true, analyte: true, takenAt: true },
  });
  return candidates[0] ?? null;
}
