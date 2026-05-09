import { prisma } from "@/lib/db";
import { verifyRegistration } from "@/lib/auth/passkey";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } =
    await safeJson<Record<string, unknown>>(request);

  if (jsonError) return jsonError;
  const challengeId = body.challengeId as string | undefined;
  const credential = body.credential as Record<string, unknown> | undefined;

  if (!challengeId || !credential) {
    return apiError("challengeId and credential required", 422);
  }

  const verification = await verifyRegistration(challengeId, credential);

  if (!verification.verified || !verification.registrationInfo) {
    return apiError("Passkey verification failed", 400);
  }

  const { registrationInfo } = verification;

  await prisma.passkey.create({
    data: {
      userId: user.id,
      credentialId: registrationInfo.credential.id,
      credentialPublicKey: Buffer.from(registrationInfo.credential.publicKey),
      counter: BigInt(registrationInfo.credential.counter),
      credentialDeviceType: registrationInfo.credentialDeviceType,
      credentialBackedUp: registrationInfo.credentialBackedUp,
      transports:
        ((credential.response as Record<string, unknown> | undefined)
          ?.transports as string[]) ?? [],
    },
  });

  await auditLog("auth.passkey.register", {
    userId: user.id,
    ipAddress: getClientIp(request),
  });

  annotate({ action: { name: "auth.passkey.register" } });

  return apiSuccess({ verified: true });
});
