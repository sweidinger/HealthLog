/**
 * scripts/decrypt-export.ts <archive.hlx> [output.json]
 *
 * Standalone decryptor for a passphrase-encrypted HealthLog export (`HLX1`
 * wire format — see src/lib/export/passphrase-archive.ts). A user runs this
 * with their passphrase to recover the plaintext JSON backup WITHOUT the app:
 *
 *   pnpm dlx tsx scripts/decrypt-export.ts healthlog-backup-....hlx
 *
 * The passphrase is read interactively with echo disabled, or from the
 * `EXPORT_PASSPHRASE` environment variable for non-interactive use. It is
 * never written to disk or logged. There is no server-side recovery: a wrong
 * or forgotten passphrase cannot be worked around — the archive is opaque.
 *
 * If no output path is given, the decrypted JSON is written next to the input
 * with a `.json` extension; pass `-` to stream to stdout instead.
 *
 * This script depends ONLY on the archive codec (Argon2id + node:crypto) — no
 * database, no Prisma, no app boot — so it stays runnable from a checkout with
 * just `pnpm install`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { decryptArchive } from "@/lib/export/passphrase-archive";

function usage(): never {
  console.error(
    "Usage: pnpm dlx tsx scripts/decrypt-export.ts <archive.hlx> [output.json|-]",
  );
  process.exit(2);
}

/** Read a line from the TTY with local echo disabled. */
async function promptPassphrase(): Promise<string> {
  const fromEnv = process.env.EXPORT_PASSPHRASE;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  if (!process.stdin.isTTY) {
    console.error(
      "No TTY available and EXPORT_PASSPHRASE is unset — cannot read passphrase.",
    );
    process.exit(2);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Mute echo: intercept the output stream while the prompt is active.
  const out = process.stdout;
  let muted = false;
  const realWrite = out.write.bind(out);
  (out as unknown as { write: typeof out.write }).write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ) => {
    if (muted) return true;
    // @ts-expect-error variadic passthrough
    return realWrite(chunk, ...rest);
  }) as typeof out.write;

  process.stdout.write("Passphrase: ");
  muted = true;
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question("", resolve);
    });
    return answer;
  } finally {
    muted = false;
    (out as unknown as { write: typeof out.write }).write = realWrite;
    process.stdout.write("\n");
    rl.close();
  }
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) usage();
  const output = process.argv[3] ?? input.replace(/\.hlx$/i, "") + ".json";

  const buf = await readFile(input);
  const passphrase = await promptPassphrase();

  let plaintext: string;
  try {
    plaintext = await decryptArchive(buf, passphrase);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  if (output === "-") {
    process.stdout.write(plaintext);
    if (!plaintext.endsWith("\n")) process.stdout.write("\n");
  } else {
    await writeFile(output, plaintext, "utf8");
    console.error(`Decrypted -> ${output}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
