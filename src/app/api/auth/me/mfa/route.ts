/**
 * GET /api/auth/me/mfa
 *
 * Second-factor status for the security settings hub: whether TOTP is active,
 * how many recovery codes remain, and the registered WebAuthn security keys.
 * Gated by `requireMfaManagementAuth`: a cookie session, or a Bearer token
 * presenting a single-use step-up elevation. A token alone is not enough.
 *
 * Returns only metadata: no secret, no recovery-code plaintext, no public key.
 */
import { apiHandler, requireMfaManagementAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { countRemainingRecoveryCodes } from "@/lib/auth/mfa/recovery-codes";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireMfaManagementAuth();

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
