/**
 * v1.19.0 — ECG waveform Bytes-codec round-trip tests.
 *
 * The raw micro-volt sample array is stored AES-256-GCM encrypted in the
 * `ecg_recordings.waveform_encrypted` Bytes column. These tests assert the
 * encrypt → Bytes → decrypt round-trip preserves the array exactly, that the
 * stored bytes are NOT plaintext (no cleartext sample shows through), and that
 * a tampered / non-array payload fails closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCryptoCacheForTests, encrypt } from "@/lib/crypto";
import {
  decryptWaveformFromBytes,
  encryptWaveformToBytes,
} from "../ecg-waveform-codec";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY);
  _resetCryptoCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetCryptoCacheForTests();
});

describe("ecg-waveform-codec", () => {
  it("round-trips a sample array through encrypt → Bytes → decrypt", () => {
    const samples = [0, 12, -47, 1024, -2048, 999999, -1000000, 1];
    const bytes = encryptWaveformToBytes(samples);
    expect(decryptWaveformFromBytes(bytes)).toEqual(samples);
  });

  it("round-trips an empty array", () => {
    const bytes = encryptWaveformToBytes([]);
    expect(decryptWaveformFromBytes(bytes)).toEqual([]);
  });

  it("stores the waveform encrypted, not as plaintext", () => {
    const samples = [424242, -313131];
    const bytes = encryptWaveformToBytes(samples);
    const asText = Buffer.from(bytes).toString("utf8");
    // The ciphertext is `<keyId>.<base64>`; no raw sample value leaks.
    expect(asText).not.toContain("424242");
    expect(asText).not.toContain("-313131");
    expect(asText.startsWith("v1.")).toBe(true);
  });

  it("fails closed on a payload that does not decode to a number array", () => {
    // Hand-encrypt a non-array JSON value through the same active key.
    const tampered = Buffer.from(encrypt(JSON.stringify({ not: "an array" })));
    expect(() => decryptWaveformFromBytes(tampered)).toThrow(/number array/);
  });
});
