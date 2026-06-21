/**
 * AES-256-GCM ↔ `Bytes` codec for the ECG waveform column (v1.19.0).
 *
 * `ecg_recordings.waveform_encrypted` stores the JSON-encoded micro-volt
 * sample array (`number[]`) as the `encrypt()` string format from
 * `@/lib/crypto` (`"<keyId>.<base64>"`) encoded as UTF-8 bytes — the same
 * Bytes-codec shape the Coach's encrypted columns use. The waveform is raw
 * health data and is NEVER persisted as plaintext; crypto is fail-closed
 * (a missing / malformed key throws rather than writing plaintext).
 *
 * Prisma's `Bytes` maps to `Uint8Array<ArrayBuffer>`, so writes allocate a
 * fresh ArrayBuffer-backed `Uint8Array` to keep the structural type stable.
 */
import { Buffer } from "node:buffer";

import { decrypt, encrypt } from "@/lib/crypto";

/** Encrypt a waveform sample array into the `Bytes` payload the schema stores. */
export function encryptWaveformToBytes(
  samples: number[],
): Uint8Array<ArrayBuffer> {
  const ciphertext = encrypt(JSON.stringify(samples));
  const encoded = Buffer.from(ciphertext, "utf8");
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

/**
 * Decrypt a `Bytes` waveform payload back to the sample array. Throws on a
 * bad key id (fail-closed) or a non-array payload.
 */
export function decryptWaveformFromBytes(buf: Uint8Array): number[] {
  const text = Buffer.from(buf).toString("utf8");
  const parsed: unknown = JSON.parse(decrypt(text));
  if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === "number")) {
    throw new Error("ECG waveform payload did not decode to a number array");
  }
  return parsed as number[];
}
