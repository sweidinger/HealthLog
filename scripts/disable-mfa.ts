/**
 * scripts/disable-mfa.ts <email-or-username>
 *
 * Operator escape hatch: clear the second factor for an account whose owner
 * has locked themselves out (lost authenticator AND recovery codes). Mirrors
 * the password-reset CLI — it runs out-of-band against the database, so it is
 * the recovery path of last resort for a self-hoster.
 *
 * It clears the TOTP secret, the confirmed-at stamp and the replay counter,
 * and deletes every recovery code, then writes an `auth.mfa.disabled` audit
 * row (with `details.source = "cli"`) so the action is traceable.
 *
 * Run via the bundled tsx (the production standalone image strips tsx):
 *   pnpm dlx tsx scripts/disable-mfa.ts user@example.com
 */
import "dotenv/config";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const identifier = process.argv[2];
if (!identifier) {
  console.error(
    "Usage: pnpm dlx tsx scripts/disable-mfa.ts <email-or-username>",
  );
  process.exit(2);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
});

async function main(): Promise<void> {
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: { equals: identifier, mode: "insensitive" } },
        { username: { equals: identifier, mode: "insensitive" } },
      ],
    },
    select: { id: true, username: true, totpConfirmedAt: true },
  });

  if (!user) {
    console.error(`No account matches '${identifier}'.`);
    process.exit(3);
  }

  if (!user.totpConfirmedAt) {
    console.log(
      `Account '${user.username}' has no active second factor — nothing to do.`,
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        totpSecretEncrypted: null,
        totpConfirmedAt: null,
        totpLastStep: null,
      },
    });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
    await tx.auditLog.create({
      data: {
        action: "auth.mfa.disabled",
        userId: user.id,
        details: JSON.stringify({ source: "cli", factor: "totp" }),
      },
    });
  });

  console.log(`Second factor cleared for account '${user.username}'.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
