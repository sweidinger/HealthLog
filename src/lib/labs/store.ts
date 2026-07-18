/**
 * v1.17.1 — server-side helpers for the structured lab-result store.
 *
 * The AES-256-GCM ↔ `Bytes` codec for `LabResult.noteEncrypted`. The
 * free-text note is the only sensitive column on the model; it shares the
 * `encrypt()` string format (`"<keyId>.<base64>"`) every other `*Encrypted`
 * column uses, encoded as UTF-8 bytes.
 */
import { Buffer } from "node:buffer";

import { decrypt, encrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";

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
 * Decrypt a stored `Bytes` note, fail-soft to `null` on any error.
 *
 * Mirrors `decryptContextSoft` in the biomarker store: a single bad-key /
 * malformed row must not fail a bulk read (list view, backup export) that
 * spans many rows. The single-resource GET path uses the throwing
 * `decryptNoteFromBytes` so a genuine decrypt failure there surfaces instead
 * of silently masking a key-rotation gap.
 */
export function decryptNoteSoft(buf: Uint8Array | null): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptNoteFromBytes(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `lab note decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
