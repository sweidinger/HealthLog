/**
 * GET /api/auth/me/mfa
 *
 * Second-factor status for the security settings hub: whether TOTP is active,
 * how many recovery codes remain, and the registered WebAuthn security keys.
 * Cookie-only (`requireCookieAuth`) — managing MFA is never a Bearer surface.
 *
 * Returns only metadata: no secret, no recovery-code plaintext, no public key.
 */
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { countRemainingRecoveryCodes } from "@/lib/auth/mfa/recovery-codes";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireCookieAuth();

  const [recoveryCodesRemaining, webauthn] = await Promise.all([
    countRemainingRecoveryCodes(user.id),
    prisma.webauthnMfaCredential.findMany({
      where: { userId: user.id },
      select: { id: true, name: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  annotate({ action: { name: "auth.mfa.status" } });

  return apiSuccess({
    totp: { enabled: Boolean(user.totpConfirmedAt) },
    recoveryCodesRemaining,
    webauthn,
    // The security hub also drives the passkey-upgrade nudge from this one
    // status read, so it knows whether the user has already dismissed it.
    passkeyNudgeDismissed: Boolean(user.passkeyUpgradeNudgeDismissed),
  });
});
