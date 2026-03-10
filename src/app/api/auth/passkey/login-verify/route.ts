import { verifyAuthentication } from "@/lib/auth/passkey";
import { createSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp, safeJson } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const POST = apiHandler(async (request: NextRequest) => {
  await ensureDbCompatibility();

  const ip = getClientIp(request);
  const rl = await checkRateLimit(`auth:passkey-verify:${ip}`, 10, 15 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Zu viele Versuche. Bitte 15 Minuten warten.", 429);
  }

  const { data: body, error: jsonError } = await safeJson<Record<string, unknown>>(request);

  if (jsonError) return jsonError;
  const challengeId = body.challengeId as string | undefined;
  const credential = body.credential;

  if (!challengeId || !credential) {
    return apiError("challengeId und credential erforderlich", 422);
  }

  const { verification, passkey } = await verifyAuthentication(
    challengeId,
    credential,
  );

  if (!verification.verified) {
    await auditLog("auth.login.failed", {
      ipAddress: ip,
      details: { reason: "passkey_verification_failed" },
    });
    return apiError("Passkey-Verifizierung fehlgeschlagen", 401);
  }

  const user = await prisma.user.findUnique({
    where: { id: passkey.userId },
  });

  if (!user) {
    return apiError("Benutzer nicht gefunden", 404);
  }

  const ua = request.headers.get("user-agent");
  await createSession(user.id, ip, ua);

  await auditLog("auth.login.passkey", {
    userId: user.id,
    ipAddress: ip,
  });

  annotate({ action: { name: "auth.login.passkey" } });

  return apiSuccess({
    user: { id: user.id, username: user.username },
  });
});
