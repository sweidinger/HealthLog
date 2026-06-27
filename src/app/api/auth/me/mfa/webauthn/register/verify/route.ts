/**
 * POST /api/auth/me/mfa/webauthn/register/verify
 *
 * Finish registering a WebAuthn security key as a second factor. Cookie-only.
 * Verifies the attestation against the user-bound challenge and stores the
 * credential in `WebauthnMfaCredential` (kept separate from primary passkeys).
 */
import { NextRequest } from "next/server";
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { verifyMfaRegistration } from "@/lib/auth/mfa/webauthn";
import { mfaWebauthnRegisterVerifySchema } from "@/lib/validations/mfa";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireCookieAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = mfaWebauthnRegisterVerifySchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid request", 422);
  }
  const { challengeId, credential, name } = parsed.data;

  const verification = await verifyMfaRegistration(
    challengeId,
    user.id,
    credential,
  );
  if (!verification.verified || !verification.registrationInfo) {
    return apiError("Security key verification failed", 400);
  }

  const { registrationInfo } = verification;
  const created = await prisma.webauthnMfaCredential.create({
    data: {
      userId: user.id,
      name: name ?? "Security key",
      credentialId: registrationInfo.credential.id,
      credentialPublicKey: Buffer.from(registrationInfo.credential.publicKey),
      counter: BigInt(registrationInfo.credential.counter),
      transports:
        ((credential.response as Record<string, unknown> | undefined)
          ?.transports as string[]) ?? [],
    },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true },
  });

  await auditLog("auth.mfa.webauthn.register", {
    userId: user.id,
    ipAddress: getClientIp(request),
  });
  annotate({ action: { name: "auth.mfa.webauthn.register" } });

  return apiSuccess(created);
});
