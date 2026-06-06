/**
 * scripts/reset-password.mjs — operator-only CLI to reset a single user's
 * password from inside the running container.
 *
 * WHY plain `.mjs` and not the `.ts` scripts pattern: the production standalone
 * image strips `tsx` and ships the Prisma client only as bundled TypeScript
 * inside `server.js` (not importable from a standalone process). This script
 * therefore talks to Postgres through `pg` (present in the image) and hashes
 * with `@node-rs/argon2` (also present), reusing the ONE shared Argon2id param
 * object that the app's `hashPassword()` uses, so the hash it writes is
 * byte-compatible with a hash the app would mint.
 *
 * Usage (inside the container — operator only):
 *   docker compose exec app node scripts/reset-password.mjs <username-or-email> [new-password]
 *
 * If the password is omitted it is read from stdin without echoing. The
 * password is never printed back. Exits non-zero with a clear message when the
 * identifier matches zero or more than one user.
 *
 * Reads `DATABASE_URL` from the environment (the same var the app uses). The
 * connection honours any `sslmode=` in the URL exactly like the app pool.
 */

import { createInterface } from "node:readline";
import { hash } from "@node-rs/argon2";
import pg from "pg";
import { ARGON2_HASH_OPTIONS } from "../src/lib/auth/argon2-params.mjs";

function fail(message) {
  console.error(`reset-password: ${message}`);
  process.exit(1);
}

/** Read a line from stdin without echoing it to the terminal. */
function promptHidden(label) {
  return new Promise((resolve) => {
    process.stdout.write(label);
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    // Override the line-writer so typed characters are never echoed. The
    // prompt label above is already written; the closing newline is emitted
    // when the answer resolves.
    rl._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const identifier = process.argv[2];
  if (!identifier) {
    fail(
      "usage: node scripts/reset-password.mjs <username-or-email> [new-password]",
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    fail("DATABASE_URL must be set");
  }

  let newPassword = process.argv[3];
  if (!newPassword) {
    newPassword = await promptHidden("New password (input hidden): ");
  }
  if (!newPassword || newPassword.length < 12) {
    fail("new password must be at least 12 characters");
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Case-insensitive match on username OR email, mirroring the login lookup.
    // Scope to a single user: zero or multiple matches is a hard error so an
    // operator never silently resets the wrong account.
    const found = await client.query(
      `SELECT id, username FROM users
       WHERE lower(username) = lower($1) OR lower(email) = lower($1)`,
      [identifier],
    );

    if (found.rowCount === 0) {
      fail(`no user matches "${identifier}"`);
    }
    if (found.rowCount > 1) {
      fail(
        `"${identifier}" matches ${found.rowCount} users — refusing to guess; reset by exact username`,
      );
    }

    const user = found.rows[0];
    const passwordHash = await hash(newPassword, ARGON2_HASH_OPTIONS);

    await client.query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [passwordHash, user.id],
    );

    // Never echo the password; confirm by username only.
    console.log(`reset-password: password updated for "${user.username}"`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
