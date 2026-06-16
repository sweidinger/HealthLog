/**
 * v1.18.1 — server-side helpers for the user-scoped Biomarker catalog.
 *
 * The AES-256-GCM ↔ `Bytes` codec for `Biomarker.contextEncrypted`. The
 * per-marker context note ("what this means") is the only sensitive column on
 * the model; it shares the `encrypt()` string format (`"<keyId>.<base64>"`)
 * every other `*Encrypted` column uses, encoded as UTF-8 bytes.
 *
 * Mirrors the `LabResult.noteEncrypted` codec in `./store.ts` so the two
 * encrypted columns on the Labs feature share one byte layout.
 */
import { Buffer } from "node:buffer";

import { decrypt, encrypt } from "@/lib/crypto";

/** Encrypt a UTF-8 context note into the `Bytes` payload the schema stores. */
export function encryptContextToBytes(
  plaintext: string,
): Uint8Array<ArrayBuffer> {
  const ciphertext = encrypt(plaintext);
  const encoded = Buffer.from(ciphertext, "utf8");
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

/** Decrypt a stored `Bytes` context note back to plaintext. */
export function decryptContextFromBytes(buf: Uint8Array): string {
  return decrypt(Buffer.from(buf).toString("utf8"));
}
