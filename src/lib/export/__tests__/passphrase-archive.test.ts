import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  encryptArchive,
  decryptArchive,
  parseArchiveHeader,
  EXPORT_ARGON2_PARAMS,
  MIN_EXPORT_PASSPHRASE_LENGTH,
} from "../passphrase-archive";

const PASSPHRASE = "correct horse battery staple";
const PAYLOAD = JSON.stringify({
  schemaVersion: 1,
  measurements: [{ type: "WEIGHT", value: 81.2, unit: "kg" }],
  note: "Zugangsdaten 🔐 € ñ",
});

describe("passphrase-encrypted export archive (HLX1)", () => {
  it("round-trips encrypt -> decrypt with the right passphrase", async () => {
    const archive = await encryptArchive(PAYLOAD, PASSPHRASE);
    const out = await decryptArchive(archive, PASSPHRASE);
    expect(out).toBe(PAYLOAD);
  });

  it("emits the HLX1 magic + version header", async () => {
    const archive = await encryptArchive(PAYLOAD, PASSPHRASE);
    expect(archive.subarray(0, 4).toString("ascii")).toBe("HLX1");
    expect(archive.readUInt8(4)).toBe(0x01); // version
    expect(archive.readUInt8(5)).toBe(0x01); // KDF = Argon2id
  });

  it("carries the Argon2id KDF params + salt in the header", async () => {
    const archive = await encryptArchive(PAYLOAD, PASSPHRASE);
    const { header, bodyOffset } = parseArchiveHeader(archive);
    expect(header.memoryCost).toBe(EXPORT_ARGON2_PARAMS.memoryCost);
    expect(header.timeCost).toBe(EXPORT_ARGON2_PARAMS.timeCost);
    expect(header.parallelism).toBe(EXPORT_ARGON2_PARAMS.parallelism);
    expect(header.salt.length).toBe(16);
    expect(bodyOffset).toBe(16 + 16 + 12 + 16); // header + salt + iv + tag
  });

  it("uses a random salt + iv so two archives of the same input differ", async () => {
    const a = await encryptArchive(PAYLOAD, PASSPHRASE);
    const b = await encryptArchive(PAYLOAD, PASSPHRASE);
    expect(Buffer.compare(a, b)).not.toBe(0);
    // ...but both decrypt back to the same plaintext.
    expect(await decryptArchive(a, PASSPHRASE)).toBe(PAYLOAD);
    expect(await decryptArchive(b, PASSPHRASE)).toBe(PAYLOAD);
  });

  it("fails cleanly with a wrong passphrase (no plaintext leak)", async () => {
    const archive = await encryptArchive(PAYLOAD, PASSPHRASE);
    await expect(
      decryptArchive(archive, "totally wrong passphrase"),
    ).rejects.toThrow(/wrong passphrase or corrupt archive/i);
  });

  it("fails when the ciphertext is tampered", async () => {
    const archive = await encryptArchive(PAYLOAD, PASSPHRASE);
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 1] ^= 0xff; // flip a ciphertext bit
    await expect(decryptArchive(tampered, PASSPHRASE)).rejects.toThrow();
  });

  it("rejects a passphrase shorter than the minimum on encrypt", async () => {
    await expect(encryptArchive(PAYLOAD, "short")).rejects.toThrow(
      new RegExp(`at least ${MIN_EXPORT_PASSPHRASE_LENGTH}`),
    );
  });

  it("rejects a non-HLX1 buffer", () => {
    expect(() => parseArchiveHeader(Buffer.from("not an archive"))).toThrow();
  });

  it("accepts a Buffer payload, not only a string", async () => {
    const buf = Buffer.from(PAYLOAD, "utf8");
    const archive = await encryptArchive(buf, PASSPHRASE);
    expect(await decryptArchive(archive, PASSPHRASE)).toBe(PAYLOAD);
  });
});
