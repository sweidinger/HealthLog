/**
 * v1.19.0 — guard the key-rotation script against an uncovered encrypted column.
 *
 * Twice now an encrypted `Bytes` column shipped without being added to
 * `scripts/rotate-encryption-key.ts` (the v1.18.1 clinical-spine notes, then the
 * v1.19.0 ECG waveform). When a column is missing from the rotation, an operator
 * rotation leaves those rows on the legacy key, and dropping the legacy key once
 * the script reports "zero remaining" makes that data permanently undecryptable
 * (crypto is fail-closed). CLAUDE.md's invariant: the script covers EVERY
 * encrypted `Bytes` column.
 *
 * This test enumerates the encrypted `Bytes` columns straight from
 * `schema.prisma` (model + field) and asserts the rotation script references
 * both names, so a newly added encrypted blob fails CI until it is wired in.
 *
 * Non-rotation `Bytes` columns (raw avatar image, passkey public key) are not
 * encrypted at rest and are excluded by the `Encrypted` / `encryptedContent`
 * naming convention.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function isEncryptedBytesField(line: string): string | null {
  // matches e.g. `  waveformEncrypted   Bytes  @map("...")` or
  // `  encryptedContent Bytes @map("...")`
  const m = line.match(/^\s*(\w+)\s+Bytes\??\s/);
  if (!m) return null;
  const field = m[1];
  if (field.endsWith("Encrypted") || field === "encryptedContent") return field;
  return null;
}

describe("encryption key-rotation coverage", () => {
  it("rotates every encrypted Bytes column declared in the schema", () => {
    const schema = readFileSync(
      join(process.cwd(), "prisma/schema.prisma"),
      "utf8",
    );
    const script = readFileSync(
      join(process.cwd(), "scripts/rotate-encryption-key.ts"),
      "utf8",
    );

    const pairs: Array<{ model: string; field: string }> = [];
    let currentModel: string | null = null;
    for (const line of schema.split("\n")) {
      const model = line.match(/^model\s+(\w+)\s*\{/);
      if (model) {
        currentModel = model[1];
        continue;
      }
      if (line.trim() === "}") {
        currentModel = null;
        continue;
      }
      const field = isEncryptedBytesField(line);
      if (field && currentModel) pairs.push({ model: currentModel, field });
    }

    // sanity: we actually found encrypted columns to check
    expect(pairs.length).toBeGreaterThan(5);

    const missing = pairs.filter(
      ({ model, field }) =>
        !(script.includes(`"${model}"`) && script.includes(`"${field}"`)),
    );

    expect(
      missing,
      `Encrypted Bytes column(s) not wired into scripts/rotate-encryption-key.ts: ${missing
        .map((p) => `${p.model}.${p.field}`)
        .join(
          ", ",
        )}. Add a rotateBytesColumn(...) call or every rotation will ` +
        "strand this data on the legacy key.",
    ).toEqual([]);
  });
});
