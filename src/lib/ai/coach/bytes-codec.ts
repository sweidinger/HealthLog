/**
 * Shared AES-256-GCM ↔ `Bytes` codec for the Coach's encrypted columns.
 *
 * `coach_messages.encrypted_content`, `coach_conversations.summary_encrypted`,
 * and `coach_facts.fact_encrypted` all store the same payload shape: the
 * `encrypt()` string format from `@/lib/crypto` (`"<keyId>.<base64>"`) encoded
 * as UTF-8 bytes. Centralised here so there is one ArrayBuffer-backed
 * implementation every Coach persistence path shares.
 *
 * Prisma's `Bytes` type maps to `Uint8Array<ArrayBuffer>`, not Node's
 * `Buffer<ArrayBufferLike>`, so we allocate a fresh ArrayBuffer-backed
 * `Uint8Array` for writes to keep the structural type stable across Node
 * versions.
 */
import { Buffer } from "node:buffer";

import { decrypt, encrypt } from "@/lib/crypto";

/** Encrypt a UTF-8 string into the `Bytes` payload the schema stores. */
export function encryptToBytes(plaintext: string): Uint8Array<ArrayBuffer> {
  const ciphertext = encrypt(plaintext);
  const encoded = Buffer.from(ciphertext, "utf8");
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

/** Decrypt a `Bytes` payload back to its plaintext. Throws on a bad key id. */
export function decryptFromBytes(buf: Uint8Array): string {
  const text = Buffer.from(buf).toString("utf8");
  return decrypt(text);
}
