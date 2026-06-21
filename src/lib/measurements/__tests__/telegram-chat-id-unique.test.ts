import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.19.2 — `User.telegramChatId` must stay UNIQUE. The inbound webhook
 * resolves the user from the chat id; a chat shared across two accounts
 * would route a reply / button tap / numeric capture ambiguously. The
 * constraint is the structural guard, so this asserts it never silently
 * drops out of the schema on a future regeneration.
 */
const SCHEMA_PATH = join(__dirname, "../../../..", "prisma", "schema.prisma");

describe("User.telegramChatId schema invariant", () => {
  const schema = readFileSync(SCHEMA_PATH, "utf8");

  it("declares the column @unique", () => {
    const line = schema.split("\n").find((l) => l.includes("telegramChatId"));
    expect(line).toBeDefined();
    expect(line).toMatch(/@unique/);
  });

  it("ships the 0189 unique-index migration", () => {
    const migrationPath = join(
      __dirname,
      "../../../..",
      "prisma",
      "migrations",
      "0189_v1192_telegram_chat_unique_and_source",
      "migration.sql",
    );
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
    expect(sql).toMatch(/users_telegram_chat_id_key/);
  });
});
